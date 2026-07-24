import {
  authorizeHumanAction,
  type HumanPolicySubject
} from "../identity/policy.js";
import {
  actorRefFromHuman,
  type HumanAuthContext
} from "../identity/schemas.js";
import {
  WORK_ASSIGNMENT_ERROR_MESSAGES,
  allowWorkAssignment,
  denyWorkAssignment,
  type WorkAssignmentAuthDecision,
  type WorkAssignmentErrorCode
} from "./errors.js";
import {
  assertTargetAllowedForWorkItem,
  assignmentAvailabilitySchema,
  assignmentDisplayProjectionSchema,
  assignmentRecordSchema,
  isMachineAssignmentTarget,
  type AssignmentAvailability,
  type AssignmentConcurrencyFacts,
  type AssignmentDisplayProjection,
  type AssignmentHostFacts,
  type AssignmentMembershipFacts,
  type AssignmentRecord,
  type AssignmentTarget,
  type AssignmentUpdateCommand,
  type WorkItemPackageFacts,
  type WorkItemRef
} from "./schemas.js";

function denial(code: WorkAssignmentErrorCode): WorkAssignmentAuthDecision {
  return denyWorkAssignment(code, WORK_ASSIGNMENT_ERROR_MESSAGES[code]);
}

function mapHumanAuthCode(code: string): WorkAssignmentErrorCode {
  switch (code) {
    case "human_auth_unauthenticated":
      return "work_auth_unauthenticated";
    case "human_auth_project_mismatch":
      return "work_auth_project_mismatch";
    case "human_role_insufficient":
      return "work_role_insufficient";
    case "human_auth_forbidden":
    case "human_membership_required":
      return "work_auth_forbidden";
    case "human_input_invalid":
      return "work_input_invalid";
    default:
      return "work_auth_forbidden";
  }
}

/**
 * Authorization for assignment mutations.
 * Reuses the centralized human policy action `assign_work` (member or owner on project).
 * Host credentials and operator tokens are not assignment actors.
 */
export function authorizeAssignmentMutation(input: {
  subject: HumanPolicySubject;
  projectId: string;
}): WorkAssignmentAuthDecision {
  const decision = authorizeHumanAction({
    action: "assign_work",
    subject: input.subject,
    facts: { targetProjectId: input.projectId }
  });
  if (decision.allowed) {
    return allowWorkAssignment();
  }
  return denial(mapHumanAuthCode(decision.code));
}

/**
 * Host capabilities must cover every required capability from the Block's Plan Package.
 * Empty required list means no capability constraint (still subject to host auth/online rules).
 */
export function hostSatisfiesCapabilities(
  hostCapabilities: readonly string[],
  requiredCapabilities: readonly string[]
): boolean {
  if (requiredCapabilities.length === 0) return true;
  const available = new Set(hostCapabilities);
  return requiredCapabilities.every((capability) => available.has(capability));
}

/**
 * Pure target validation against WorkItem kind + membership/Host/package facts.
 * Does not authorize the actor and does not write storage.
 */
export function evaluateAssignmentTarget(input: {
  workItem: WorkItemRef;
  target: AssignmentTarget;
  packageFacts: WorkItemPackageFacts;
  membership?: AssignmentMembershipFacts;
  host?: AssignmentHostFacts;
}): WorkAssignmentAuthDecision {
  if (!input.packageFacts.exists) {
    return denial("work_item_not_found");
  }
  if (input.packageFacts.kind !== input.workItem.kind) {
    return denial("work_item_not_found");
  }
  if (input.packageFacts.canvasId !== input.workItem.canvasId) {
    return denial("work_item_not_found");
  }

  const kindOk = assertTargetAllowedForWorkItem(input.workItem, input.target);
  if (!kindOk.ok) {
    return denial("work_item_kind_target_mismatch");
  }

  switch (input.target.kind) {
    case "unassigned":
      return allowWorkAssignment();
    case "human": {
      const membership = input.membership;
      if (!membership || membership.humanPrincipalId !== input.target.humanPrincipalId) {
        return denial("work_input_invalid");
      }
      if (!membership.membershipActive) {
        return denial("work_human_not_member");
      }
      return allowWorkAssignment();
    }
    case "exact_host": {
      const host = input.host;
      if (!host || host.hostId !== input.target.hostId) {
        return denial("work_input_invalid");
      }
      if (!host.exists) {
        return denial("work_host_not_found");
      }
      if (host.revoked) {
        return denial("work_host_revoked");
      }
      if (!host.authorizedForProject) {
        return denial("work_host_not_authorized");
      }
      // Capabilities come from current Block requirements (packageFacts), never from assignment blob.
      if (
        !hostSatisfiesCapabilities(host.capabilities, input.packageFacts.requiredCapabilities)
      ) {
        return denial("work_host_capability_mismatch");
      }
      return allowWorkAssignment();
    }
    case "automatic_host":
      // Automatic selection references Block requirements at dispatch time; no capability copy here.
      return allowWorkAssignment();
    default: {
      const _exhaustive: never = input.target;
      return denial("work_input_invalid");
    }
  }
}

/**
 * Compare-and-set revision check.
 * expectedRevision must equal currentRevision (0 when no durable row).
 * On conflict return a clear error — never apply an arbitrary target.
 */
export function evaluateAssignmentRevision(input: {
  expectedRevision: number;
  currentRevision: number;
}): WorkAssignmentAuthDecision {
  if (
    !Number.isInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    !Number.isInteger(input.currentRevision) ||
    input.currentRevision < 0
  ) {
    return denial("work_input_invalid");
  }
  if (input.expectedRevision !== input.currentRevision) {
    return denial("work_revision_conflict");
  }
  return allowWorkAssignment();
}

export type AssignmentUpdateDecision =
  | {
      ok: true;
      record: AssignmentRecord;
      previousRevision: number;
      previousTarget: AssignmentTarget | undefined;
    }
  | {
      ok: false;
      code: WorkAssignmentErrorCode;
      message: string;
    };

/**
 * Pure assignment update decision (authorization + target + CAS).
 * Assignment is coordination metadata only: success does not claim, run, or dispatch a Block.
 * Plan Package is never mutated here.
 */
export function decideAssignmentUpdate(input: {
  command: AssignmentUpdateCommand;
  concurrency: AssignmentConcurrencyFacts;
  packageFacts: WorkItemPackageFacts;
  membership?: AssignmentMembershipFacts;
  host?: AssignmentHostFacts;
  now: Date;
}): AssignmentUpdateDecision {
  const { command } = input;

  if (command.actor.projectId !== command.projectId) {
    return {
      ok: false,
      code: "work_auth_project_mismatch",
      message: WORK_ASSIGNMENT_ERROR_MESSAGES.work_auth_project_mismatch
    };
  }

  const auth = authorizeAssignmentMutation({
    subject: { kind: "human", context: command.actor },
    projectId: command.projectId
  });
  if (!auth.allowed) {
    return { ok: false, code: auth.code, message: auth.message };
  }

  if (input.concurrency.current) {
    if (input.concurrency.current.projectId !== command.projectId) {
      return {
        ok: false,
        code: "work_cross_project_forbidden",
        message: WORK_ASSIGNMENT_ERROR_MESSAGES.work_cross_project_forbidden
      };
    }
  }

  const revision = evaluateAssignmentRevision({
    expectedRevision: command.expectedRevision,
    currentRevision: input.concurrency.currentRevision
  });
  if (!revision.allowed) {
    return { ok: false, code: revision.code, message: revision.message };
  }

  // Membership facts must be scoped to the assignment project (not canvas id).
  if (command.target.kind === "human" && input.membership) {
    if (input.membership.projectId !== command.projectId) {
      return {
        ok: false,
        code: "work_cross_project_forbidden",
        message: WORK_ASSIGNMENT_ERROR_MESSAGES.work_cross_project_forbidden
      };
    }
  }
  if (command.target.kind === "exact_host" && input.host) {
    if (input.host.projectId !== command.projectId) {
      return {
        ok: false,
        code: "work_cross_project_forbidden",
        message: WORK_ASSIGNMENT_ERROR_MESSAGES.work_cross_project_forbidden
      };
    }
  }

  const targetDecision = evaluateAssignmentTarget({
    workItem: command.workItem,
    target: command.target,
    packageFacts: input.packageFacts,
    membership:
      command.target.kind === "human"
        ? input.membership
        : undefined,
    host: command.target.kind === "exact_host" ? input.host : undefined
  });
  if (!targetDecision.allowed) {
    return {
      ok: false,
      code: targetDecision.code,
      message: targetDecision.message
    };
  }

  const nextRevision = input.concurrency.currentRevision + 1;
  const record = assignmentRecordSchema.parse({
    projectId: command.projectId,
    workItem: command.workItem,
    target: command.target,
    revision: nextRevision,
    updatedBy: actorRefFromHuman(command.actor),
    updatedAt: input.now.toISOString(),
    reason: command.reason
  });

  return {
    ok: true,
    record,
    previousRevision: input.concurrency.currentRevision,
    previousTarget: input.concurrency.current?.target
  };
}

/**
 * Readiness / availability for display after member or Host disappearance.
 * Never silently retargets; invalid targets remain visible until explicit reassignment.
 */
export function evaluateAssignmentAvailability(input: {
  workItem: WorkItemRef;
  target: AssignmentTarget;
  packageFacts: WorkItemPackageFacts;
  membership?: AssignmentMembershipFacts;
  host?: AssignmentHostFacts;
}): AssignmentAvailability {
  if (!input.packageFacts.exists) {
    return assignmentAvailabilitySchema.parse({
      status: "invalid",
      reason: "work_item_missing"
    });
  }

  switch (input.target.kind) {
    case "unassigned":
      return assignmentAvailabilitySchema.parse({
        status: "unassigned",
        reason: "unassigned"
      });
    case "human": {
      if (!input.membership || !input.membership.membershipActive) {
        return assignmentAvailabilitySchema.parse({
          status: "invalid",
          reason: "human_membership_inactive"
        });
      }
      return assignmentAvailabilitySchema.parse({ status: "ready", reason: "ready" });
    }
    case "exact_host": {
      if (!input.host || !input.host.exists) {
        return assignmentAvailabilitySchema.parse({
          status: "invalid",
          reason: "host_missing"
        });
      }
      if (input.host.revoked) {
        return assignmentAvailabilitySchema.parse({
          status: "invalid",
          reason: "host_revoked"
        });
      }
      if (!input.host.authorizedForProject) {
        return assignmentAvailabilitySchema.parse({
          status: "invalid",
          reason: "host_not_authorized"
        });
      }
      if (
        !hostSatisfiesCapabilities(input.host.capabilities, input.packageFacts.requiredCapabilities)
      ) {
        return assignmentAvailabilitySchema.parse({
          status: "invalid",
          reason: "host_capability_mismatch"
        });
      }
      if (!input.host.online) {
        return assignmentAvailabilitySchema.parse({
          status: "unavailable",
          reason: "host_offline"
        });
      }
      if (input.host.capacityRemaining === 0) {
        return assignmentAvailabilitySchema.parse({
          status: "unavailable",
          reason: "host_at_capacity"
        });
      }
      return assignmentAvailabilitySchema.parse({ status: "ready", reason: "ready" });
    }
    case "automatic_host":
      return assignmentAvailabilitySchema.parse({
        status: "pending",
        reason: "automatic_pending_selection"
      });
    default: {
      const _exhaustive: never = input.target;
      return assignmentAvailabilitySchema.parse({
        status: "invalid",
        reason: "work_item_missing"
      });
    }
  }
}

/**
 * Build a display projection from durable record (or none) + live facts.
 * Display-only: never authenticate or authorize from this projection.
 */
export function projectAssignmentDisplay(input: {
  projectId: string;
  workItem: WorkItemRef;
  record?: AssignmentRecord;
  packageFacts: WorkItemPackageFacts;
  membership?: AssignmentMembershipFacts;
  host?: AssignmentHostFacts;
  activeDispatch?: {
    present: boolean;
    hostId?: string;
    dispatchId?: string;
  };
}): AssignmentDisplayProjection {
  const target: AssignmentTarget = input.record?.target ?? { kind: "unassigned" };
  const availability = evaluateAssignmentAvailability({
    workItem: input.workItem,
    target,
    packageFacts: input.packageFacts,
    membership: input.membership,
    host: input.host
  });

  return assignmentDisplayProjectionSchema.parse({
    projectId: input.projectId,
    workItem: input.workItem,
    target,
    revision: input.record?.revision ?? 0,
    updatedBy: input.record?.updatedBy,
    updatedAt: input.record?.updatedAt,
    reason: input.record?.reason,
    human:
      target.kind === "human" && input.membership
        ? {
            humanPrincipalId: input.membership.humanPrincipalId,
            displayName: input.membership.displayName ?? input.membership.humanPrincipalId,
            membershipActive: input.membership.membershipActive
          }
        : undefined,
    host:
      target.kind === "exact_host" && input.host
        ? {
            hostId: input.host.hostId,
            displayName: input.host.displayName ?? input.host.hostId,
            online: input.host.online,
            authorizedForProject: input.host.authorizedForProject,
            revoked: input.host.revoked,
            capabilitiesSatisfied: hostSatisfiesCapabilities(
              input.host.capabilities,
              input.packageFacts.requiredCapabilities
            )
          }
        : undefined,
    availability,
    activeDispatch: input.activeDispatch
  });
}

// ---------------------------------------------------------------------------
// Assignment vs dispatch semantics (pure gate; wiring is B-003)
// ---------------------------------------------------------------------------

/**
 * Assignment records coordination intent.
 * Dispatch is a separate operation that may reserve a Host and start remote execution.
 * Selecting an Agent target does NOT claim or run the Block.
 */
export type CoordinationOperationKind = "assignment" | "dispatch";

export type DispatchAssignmentGateDecision =
  | {
      allowed: true;
      /**
       * How Host should be chosen for this dispatch.
       * - exact: must use assignment.hostId (still revalidate online/auth/capabilities)
       * - automatic: run deterministic selector against Block requirements from package
       * - override: explicit permitted override of human/unassigned (API-level permission)
       */
      selection: "exact" | "automatic" | "override";
      exactHostId?: string;
      /** Authoritative capabilities from package facts — never from assignment storage. */
      requiredCapabilities: string[];
    }
  | {
      allowed: false;
      code: WorkAssignmentErrorCode;
      message: string;
    };

/**
 * Pure dispatch gate against current assignment.
 * Callers must revalidate Runtime readiness, Host presence, capacity, and lease separately.
 * Never trusts a cached UI eligibility list.
 *
 * Decision table (Block only; Tasks are not remote execution units):
 *
 * | Assignment target | requestedHostId | allowHumanOverride | Result |
 * |-------------------|-----------------|--------------------|--------|
 * | unassigned        | *               | false              | work_not_agent_assigned |
 * | unassigned        | *               | true               | override / automatic if no host |
 * | human             | *               | false              | work_not_agent_assigned |
 * | human             | *               | true               | override |
 * | exact_host H      | undefined / H   | *                  | exact H |
 * | exact_host H      | H2≠H            | *                  | work_dispatch_host_mismatch |
 * | automatic_host    | undefined       | *                  | automatic (use package requirements) |
 * | automatic_host    | H               | *                  | exact H if capable else capability error at later revalidation |
 */
export function evaluateDispatchAgainstAssignment(input: {
  workItem: WorkItemRef;
  packageFacts: WorkItemPackageFacts;
  /** Current durable target; treat missing as unassigned. */
  target?: AssignmentTarget;
  requestedHostId?: string;
  /** Explicit API permission to dispatch despite human/unassigned coordination. */
  allowHumanOverride?: boolean;
}): DispatchAssignmentGateDecision {
  if (input.workItem.kind !== "block") {
    return {
      allowed: false,
      code: "work_item_kind_target_mismatch",
      message: WORK_ASSIGNMENT_ERROR_MESSAGES.work_item_kind_target_mismatch
    };
  }
  if (!input.packageFacts.exists || input.packageFacts.kind !== "block") {
    return {
      allowed: false,
      code: "work_item_not_found",
      message: WORK_ASSIGNMENT_ERROR_MESSAGES.work_item_not_found
    };
  }

  const target = input.target ?? { kind: "unassigned" as const };
  const requiredCapabilities = [...input.packageFacts.requiredCapabilities];

  switch (target.kind) {
    case "unassigned":
    case "human": {
      if (!input.allowHumanOverride) {
        return {
          allowed: false,
          code: "work_not_agent_assigned",
          message: WORK_ASSIGNMENT_ERROR_MESSAGES.work_not_agent_assigned
        };
      }
      if (input.requestedHostId) {
        return {
          allowed: true,
          selection: "override",
          exactHostId: input.requestedHostId,
          requiredCapabilities
        };
      }
      return {
        allowed: true,
        selection: "override",
        requiredCapabilities
      };
    }
    case "exact_host": {
      if (
        input.requestedHostId !== undefined &&
        input.requestedHostId !== target.hostId
      ) {
        return {
          allowed: false,
          code: "work_dispatch_host_mismatch",
          message: WORK_ASSIGNMENT_ERROR_MESSAGES.work_dispatch_host_mismatch
        };
      }
      return {
        allowed: true,
        selection: "exact",
        exactHostId: target.hostId,
        requiredCapabilities
      };
    }
    case "automatic_host": {
      if (input.requestedHostId) {
        return {
          allowed: true,
          selection: "exact",
          exactHostId: input.requestedHostId,
          requiredCapabilities
        };
      }
      return {
        allowed: true,
        selection: "automatic",
        requiredCapabilities
      };
    }
    default: {
      const _exhaustive: never = target;
      return {
        allowed: false,
        code: "work_input_invalid",
        message: WORK_ASSIGNMENT_ERROR_MESSAGES.work_input_invalid
      };
    }
  }
}

/**
 * Active dispatch is not silently migrated by reassignment.
 * Pure helper for application layers: when assignment changes while a dispatch is active,
 * surface the actual dispatch Host and require cancel/retry rather than rewriting the lease.
 */
function assignmentTargetsEqual(left: AssignmentTarget, right: AssignmentTarget): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "human" && right.kind === "human") {
    return left.humanPrincipalId === right.humanPrincipalId;
  }
  if (left.kind === "exact_host" && right.kind === "exact_host") {
    return left.hostId === right.hostId;
  }
  return true;
}

export function assignmentChangeAffectsActiveDispatch(input: {
  previousTarget: AssignmentTarget | undefined;
  nextTarget: AssignmentTarget;
  activeDispatchHostId?: string;
}): {
  reassignmentWhileDispatchActive: boolean;
  requiresCancelOrRetry: boolean;
  activeDispatchHostId?: string;
} {
  if (input.activeDispatchHostId === undefined) {
    return {
      reassignmentWhileDispatchActive: false,
      requiresCancelOrRetry: false
    };
  }
  const previous = input.previousTarget ?? { kind: "unassigned" as const };
  const changed = !assignmentTargetsEqual(previous, input.nextTarget);
  return {
    reassignmentWhileDispatchActive: changed,
    requiresCancelOrRetry: changed,
    activeDispatchHostId: input.activeDispatchHostId
  };
}

/** Human auth context convenience subject builder for assignment policy tests. */
export function humanSubjectForAssignment(context: HumanAuthContext): HumanPolicySubject {
  return { kind: "human", context };
}

export { isMachineAssignmentTarget };
