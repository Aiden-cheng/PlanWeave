import { opaqueIdentifierSchema } from "@planweave-ai/distributed-protocol";
import { z } from "zod";
import { workspaceIdSchema } from "@planweave-ai/collaboration-contracts";
import { capabilitiesSchema } from "../protocol.js";
import type { SqliteDatabase } from "../sqlite.js";
import { WORK_ASSIGNMENT_ERROR_MESSAGES, type WorkAssignmentErrorCode } from "./errors.js";
import {
  evaluateDispatchAgainstAssignment,
  type DispatchAssignmentGateDecision
} from "./policy.js";
import type { WorkAssignmentRepository } from "./repository.js";
import { AuthorityRepository } from "./authorityRepository.js";
import { hostCanSatisfyBlock } from "./authorityPolicy.js";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import type { AgentHostRepository } from "../hosts.js";
import type { ProjectAccessRepository } from "../projectAccessRepository.js";
import {
  assignmentTargetSchema,
  workItemPackageFactsSchema,
  workItemRefSchema,
  type WorkItemPackageFacts,
  type WorkItemRef
} from "./schemas.js";

/**
 * Authorized Host selection snapshot captured when dispatch begins.
 * Kept separate from assignment mutations so reassignment does not migrate an active lease.
 * Must be durable on the remote operation so restart cannot re-resolve from a later assignment.
 */
export const dispatchHostSelectionSnapshotSchema = z
  .object({
    assignmentRevision: z.number().int().nonnegative(),
    authorityRevisions: z
      .object({
        responsibilityRevision: z.number().int().nonnegative(),
        reviewerRevision: z.number().int().nonnegative(),
        executionTargetRevision: z.number().int().nonnegative()
      })
      .strict()
      .optional(),
    target: assignmentTargetSchema,
    selection: z.enum(["exact", "automatic", "override"]),
    preferredHostId: opaqueIdentifierSchema.optional(),
    requiredCapabilities: capabilitiesSchema
  })
  .strict();
export type DispatchHostSelectionSnapshot = z.infer<typeof dispatchHostSelectionSnapshotSchema>;

export type ResolveDispatchAssignmentInput = {
  projectId: string;
  workItem: WorkItemRef;
  /** Authoritative Block requirements from Runtime/package — never a UI eligibility cache. */
  packageFacts: WorkItemPackageFacts;
  requestedHostId?: string;
  allowHumanOverride?: boolean;
  /**
   * Optional CAS fingerprint from the caller. When set, must equal the durable assignment
   * revision (0 when no row). Mismatch → work_revision_conflict rather than an arbitrary Host.
   */
  expectedAssignmentRevision?: number;
};

export type ResolveDispatchAssignmentResult =
  | { ok: true; snapshot: DispatchHostSelectionSnapshot }
  | { ok: false; code: WorkAssignmentErrorCode; message: string };

/**
 * Read current Block assignment and decide Host selection for a separate dispatch operation.
 * Does not write assignment rows and does not reserve capacity.
 */
export function resolveDispatchAssignment(
  repository: WorkAssignmentRepository,
  input: ResolveDispatchAssignmentInput
): ResolveDispatchAssignmentResult {
  const workItem = workItemRefSchema.parse(input.workItem);
  const packageFacts = workItemPackageFactsSchema.parse(input.packageFacts);

  if (workItem.kind !== "block") {
    return {
      ok: false,
      code: "work_item_kind_target_mismatch",
      message: WORK_ASSIGNMENT_ERROR_MESSAGES.work_item_kind_target_mismatch
    };
  }

  const concurrency = repository.getConcurrency(input.projectId, workItem);
  if (
    input.expectedAssignmentRevision !== undefined &&
    input.expectedAssignmentRevision !== concurrency.currentRevision
  ) {
    return {
      ok: false,
      code: "work_revision_conflict",
      message: WORK_ASSIGNMENT_ERROR_MESSAGES.work_revision_conflict
    };
  }

  const target = concurrency.current?.target ?? { kind: "unassigned" as const };
  const gate: DispatchAssignmentGateDecision = evaluateDispatchAgainstAssignment({
    workItem,
    packageFacts,
    target,
    requestedHostId: input.requestedHostId,
    allowHumanOverride: input.allowHumanOverride
  });
  if (!gate.allowed) {
    return { ok: false, code: gate.code, message: gate.message };
  }

  return {
    ok: true,
    snapshot: {
      assignmentRevision: concurrency.currentRevision,
      target,
      selection: gate.selection,
      preferredHostId: gate.exactHostId,
      requiredCapabilities: gate.requiredCapabilities
    }
  };
}

export class DispatchAssignmentError extends Error {
  constructor(
    readonly code: WorkAssignmentErrorCode,
    message: string = WORK_ASSIGNMENT_ERROR_MESSAGES[code]
  ) {
    super(message);
    this.name = "DispatchAssignmentError";
  }
}

export type AssignmentDispatchGate = {
  /**
   * Resolve Host selection before reservation. Throws DispatchAssignmentError on denial.
   * Callers must not pass UI eligibility lists as authority — only package capabilities.
   */
  resolve(input: {
    projectId: string;
    canvasId: string;
    blockRef: string;
    requiredCapabilities: readonly string[];
    requestedHostId?: string;
    allowHumanOverride?: boolean;
    expectedAssignmentRevision?: number;
    expectedResponsibilityRevision?: number;
    expectedReviewerRevision?: number;
    expectedExecutionTargetRevision?: number;
    /**
     * Force the dual assignment/authority router onto OSS-003 authority tables even when
     * expected*Revision fingerprints are omitted (retry_new_attempt re-snapshot path).
     */
    preferAuthority?: boolean;
  }): DispatchHostSelectionSnapshot;
};

export type CreateAssignmentDispatchGateOptions = {
  repository: WorkAssignmentRepository;
  /**
   * When the request omits allowHumanOverride, use this default.
   * Operator-backed paths may set true for backward-compatible unassigned dispatch;
   * human collaboration paths should leave false.
   */
  defaultAllowHumanOverride?: boolean;
};

/**
 * Application gate used by RemoteBlockCoordinator before Host reservation.
 * Assignment repository reads stay outside the reservation transaction.
 */
export function createAssignmentDispatchGate(
  options: CreateAssignmentDispatchGateOptions
): AssignmentDispatchGate {
  const defaultAllowHumanOverride = options.defaultAllowHumanOverride ?? false;
  return {
    resolve(input) {
      const workItem = workItemRefSchema.parse({
        kind: "block",
        canvasId: input.canvasId,
        blockRef: input.blockRef
      });
      const packageFacts = workItemPackageFactsSchema.parse({
        canvasId: input.canvasId,
        kind: "block",
        exists: true,
        blockRef: input.blockRef,
        requiredCapabilities: [...input.requiredCapabilities]
      });
      const result = resolveDispatchAssignment(options.repository, {
        projectId: input.projectId,
        workItem,
        packageFacts,
        requestedHostId: input.requestedHostId,
        allowHumanOverride: input.allowHumanOverride ?? defaultAllowHumanOverride,
        expectedAssignmentRevision: input.expectedAssignmentRevision
      });
      if (!result.ok) {
        throw new DispatchAssignmentError(result.code, result.message);
      }
      return result.snapshot;
    }
  };
}

export type CreateAuthorityDispatchGateOptions = {
  repository: AuthorityRepository;
  database: SqliteDatabase;
  workspaceIdentity: WorkspaceIdentityRepository;
  hosts: AgentHostRepository;
  access: ProjectAccessRepository;
  hostOfflineAfterMs: number;
  clock?: () => Date;
};

/**
 * Strict OSS-003 gate.  It reads only the separated authority tables, verifies all
 * three revision fingerprints, and resolves an eligible Host immediately before
 * reservation.  Legacy assignment rows are never consulted on this path.
 */
export function createAuthorityDispatchGate(
  options: CreateAuthorityDispatchGateOptions
): AssignmentDispatchGate {
  const clock = options.clock ?? (() => new Date());
  const scopeFor = (input: { projectId: string; canvasId: string; blockRef: string }) => {
    const workspaceId = options.workspaceIdentity.workspaceForLegacyProject(input.projectId) ?? "";
    return {
      kind: "block" as const,
      workspaceId,
      projectId: input.projectId,
      canvasId: input.canvasId,
      blockRef: input.blockRef
    };
  };
  return {
    resolve(input) {
      const hasResponsibility = input.expectedResponsibilityRevision !== undefined;
      const hasReviewer = input.expectedReviewerRevision !== undefined;
      const hasExecutionTarget = input.expectedExecutionTargetRevision !== undefined;
      const hasAnyExpected = hasResponsibility || hasReviewer || hasExecutionTarget;
      const hasAllExpected = hasResponsibility && hasReviewer && hasExecutionTarget;
      // Partial fingerprints are never "don't care" — require all three or none.
      // None means resolve against current authority tables (retry re-snapshot).
      if (hasAnyExpected && !hasAllExpected) {
        throw new DispatchAssignmentError("work_revision_conflict");
      }
      const scope = {
        ...scopeFor(input),
        workspaceId: workspaceIdSchema.parse(scopeFor(input).workspaceId)
      };
      if (!scope.workspaceId || !options.workspaceIdentity.workspaceExists(scope.workspaceId)) {
        throw new DispatchAssignmentError("work_host_not_authorized");
      }
      const project = options.access.registry.projectInternal(scope.workspaceId, scope.projectId);
      const canvas = options.access.registry.canvasInternal(
        scope.workspaceId,
        scope.projectId,
        scope.canvasId
      );
      if (!project || project.revokedAt !== null || !canvas || canvas.revokedAt !== null) {
        throw new DispatchAssignmentError("work_host_not_authorized");
      }
      const current = options.repository.currentRevisions(scope);
      if (
        hasAllExpected &&
        (current.responsibilityRevision !== input.expectedResponsibilityRevision ||
          current.reviewerRevision !== input.expectedReviewerRevision ||
          current.executionTargetRevision !== input.expectedExecutionTargetRevision)
      ) {
        throw new DispatchAssignmentError("work_revision_conflict");
      }
      const target = options.repository.getExecutionTarget(scope)?.target;
      if (!target || target.kind === "unassigned") {
        throw new DispatchAssignmentError("work_not_agent_assigned");
      }
      const now = clock();
      const activeReservations = (hostId: string): number => {
        const row = options.database
          .prepare(
            "SELECT COUNT(*) AS count FROM host_capacity_reservations WHERE host_id=? AND status='active'"
          )
          .get(hostId) as { count: number };
        return Number(row.count);
      };
      const requiredCapabilities = [...input.requiredCapabilities];
      const eligible = (hostId: string): boolean => {
        const host = options.hosts.get(hostId);
        return (
          !!host &&
          hostCanSatisfyBlock(host, {
            scope,
            requiredCapabilities,
            workspaceIdentity: options.workspaceIdentity,
            now,
            hostOfflineAfterMs: options.hostOfflineAfterMs,
            activeReservations: activeReservations(hostId)
          })
        );
      };
      let hostId: string | undefined;
      let selection: "exact" | "automatic";
      if (target.kind === "exact_host") {
        if (input.requestedHostId !== undefined && input.requestedHostId !== target.hostId) {
          throw new DispatchAssignmentError("work_dispatch_host_mismatch");
        }
        hostId = target.hostId;
        selection = "exact";
        if (!eligible(hostId)) throw new DispatchAssignmentError("work_host_not_authorized");
      } else {
        selection = "automatic";
        if (input.requestedHostId === undefined) {
          return {
            assignmentRevision: current.executionTargetRevision,
            authorityRevisions: current,
            target,
            selection,
            requiredCapabilities
          };
        }
        const candidates = options.hosts
          .list()
          .filter((host) => host.id === input.requestedHostId)
          .filter((host) => eligible(host.id))
          .sort((a, b) => {
            const activeA = activeReservations(a.id);
            const activeB = activeReservations(b.id);
            return (
              activeA - activeB ||
              (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "") ||
              a.id.localeCompare(b.id)
            );
          });
        hostId = candidates[0]?.id;
        if (!hostId) throw new DispatchAssignmentError("work_host_not_authorized");
      }
      return {
        assignmentRevision: current.executionTargetRevision,
        authorityRevisions: current,
        target,
        selection,
        preferredHostId: hostId,
        requiredCapabilities
      };
    }
  };
}

export type ActiveDispatchSnapshot = {
  present: boolean;
  hostId?: string;
  dispatchId?: string;
  operationId?: string;
  operationState?: string;
};

const ACTIVE_OPERATION_STATES = new Set([
  "preparing",
  "claimed",
  "reserved",
  "activated",
  "running",
  "interrupted",
  "action_required",
  "awaiting_writeback"
]);

/**
 * Display-only active remote dispatch for Task/Block assignment projections.
 * Does not duplicate Runtime claim state as assignment authority and never migrates leases.
 */
export function resolveActiveDispatchSnapshot(
  database: SqliteDatabase,
  input: { projectId: string; workItem: WorkItemRef }
): ActiveDispatchSnapshot {
  const workItem = workItemRefSchema.parse(input.workItem);
  if (workItem.kind !== "block") {
    return { present: false };
  }
  const row = database
    .prepare(
      `SELECT o.id AS operation_id,o.dispatch_id,o.state AS operation_state,a.host_id
       FROM remote_operations o
       JOIN remote_execution_attempts a ON a.execution_attempt_id=o.execution_attempt_id
       WHERE o.project_id=? AND o.canvas_id=? AND o.block_ref=?
         AND o.state NOT IN ('completed','failed','cancelled')
       ORDER BY o.created_at DESC,o.id DESC
       LIMIT 1`
    )
    .get(input.projectId, workItem.canvasId, workItem.blockRef) as
    | {
        operation_id: string;
        dispatch_id: string;
        operation_state: string;
        host_id: string | null;
      }
    | undefined;
  if (!row || !ACTIVE_OPERATION_STATES.has(String(row.operation_state))) {
    return { present: false };
  }
  return {
    present: true,
    hostId: row.host_id ?? undefined,
    dispatchId: String(row.dispatch_id),
    operationId: String(row.operation_id),
    operationState: String(row.operation_state)
  };
}

/**
 * Batch active-dispatch resolver for WorkAssignmentService projections.
 */
export function createActiveDispatchResolver(database: SqliteDatabase) {
  return (input: { projectId: string; workItem: WorkItemRef }) => {
    const snapshot = resolveActiveDispatchSnapshot(database, input);
    if (!snapshot.present) {
      return { present: false as const };
    }
    return {
      present: true as const,
      hostId: snapshot.hostId,
      dispatchId: snapshot.dispatchId
    };
  };
}
