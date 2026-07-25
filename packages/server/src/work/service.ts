import { ZodError } from "zod";
import { authorizeHumanAction } from "../identity/policy.js";
import {
  humanAuthContextSchema,
  humanProjectIdSchema,
  type HumanAuthContext
} from "../identity/schemas.js";
import { WORK_ASSIGNMENT_ERROR_MESSAGES, type WorkAssignmentErrorCode } from "./errors.js";
import { WORK_ASSIGNMENT_BATCH_MAX } from "./limits.js";
import { decideAssignmentUpdate, projectAssignmentDisplay } from "./policy.js";
import type { AssignmentHostPort, AssignmentMembershipPort } from "./ports.js";
import { WorkAssignmentError, WorkAssignmentRepository } from "./repository.js";
import {
  assignmentUpdateCommandSchema,
  workAssignmentBatchLimitSchema,
  workItemRefSchema,
  type AssignmentDisplayProjection,
  type AssignmentHostFacts,
  type AssignmentMembershipFacts,
  type AssignmentRecord,
  type AssignmentUpdateCommand,
  type WorkItemPackageFacts,
  type WorkItemRef
} from "./schemas.js";
import { validateWorkItemRef, type WorkItemPackagePort } from "./workItemFacts.js";

export class WorkAssignmentServiceError extends Error {
  constructor(
    readonly code: WorkAssignmentErrorCode,
    message: string = WORK_ASSIGNMENT_ERROR_MESSAGES[code]
  ) {
    super(message);
    this.name = "WorkAssignmentServiceError";
  }
}

function deny(code: WorkAssignmentErrorCode, message?: string): never {
  throw new WorkAssignmentServiceError(code, message ?? WORK_ASSIGNMENT_ERROR_MESSAGES[code]);
}

function mapRepositoryError(error: unknown): never {
  if (error instanceof WorkAssignmentError) {
    throw new WorkAssignmentServiceError(error.code, error.message);
  }
  if (error instanceof WorkAssignmentServiceError) throw error;
  if (error instanceof ZodError) {
    throw new WorkAssignmentServiceError("work_input_invalid");
  }
  throw error;
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

export type WorkAssignmentServiceOptions = {
  repository: WorkAssignmentRepository;
  packagePort: WorkItemPackagePort;
  membershipPort: AssignmentMembershipPort;
  hostPort: AssignmentHostPort;
  clock?: () => Date;
  /**
   * Optional active-dispatch snapshot for display projections only.
   * Never used to rewrite assignment or migrate leases.
   */
  resolveActiveDispatch?: (input: {
    projectId: string;
    workItem: WorkItemRef;
  }) => { present: boolean; hostId?: string; dispatchId?: string } | undefined;
};

export type EligibleAssigneesResult = {
  workItem: WorkItemRef;
  packageFacts: WorkItemPackageFacts;
  humans: AssignmentMembershipFacts[];
  hosts: AssignmentHostFacts[];
  nextHumanCursor: number | null;
  nextHostCursor: number | null;
};

export type AssignmentListResult = {
  items: AssignmentDisplayProjection[];
  nextCursor: number | null;
};

/**
 * Application service for work assignment persistence and projections.
 *
 * Validation order on mutation:
 * 1. Schema parse (command)
 * 2. Actor authorization (`assign_work`) + project scope
 * 3. Resolve current Plan Package WorkItemRef (package port)
 * 4. Resolve membership / Host facts (identity/host ports)
 * 5. Pure CAS + target decision (`decideAssignmentUpdate`)
 * 6. Transactional repository CAS write
 *
 * Never mutates Plan Package. Never claims or dispatches Blocks.
 */
export class WorkAssignmentService {
  private readonly repository: WorkAssignmentRepository;
  private readonly packagePort: WorkItemPackagePort;
  private readonly membershipPort: AssignmentMembershipPort;
  private readonly hostPort: AssignmentHostPort;
  private readonly clock: () => Date;
  private readonly resolveActiveDispatch?: WorkAssignmentServiceOptions["resolveActiveDispatch"];

  constructor(options: WorkAssignmentServiceOptions) {
    this.repository = options.repository;
    this.packagePort = options.packagePort;
    this.membershipPort = options.membershipPort;
    this.hostPort = options.hostPort;
    this.clock = options.clock ?? (() => new Date());
    this.resolveActiveDispatch = options.resolveActiveDispatch;
  }

  /**
   * Assign / reassign / unassign with expected revision (0 when no durable row).
   * Idempotent same-target updates with a matching expected revision succeed and advance revision.
   */
  updateAssignment(commandInput: unknown): {
    record: AssignmentRecord;
    previousRevision: number;
    display: AssignmentDisplayProjection;
  } {
    try {
      const command = assignmentUpdateCommandSchema.parse(commandInput) as AssignmentUpdateCommand;
      if (command.actor.projectId !== command.projectId) {
        deny("work_auth_project_mismatch");
      }

      // Package truth before mutation — deleted/renamed items fail closed.
      const packageCheck = validateWorkItemRef(this.packagePort, command.workItem);
      if (!packageCheck.ok) {
        deny(
          packageCheck.code === "work_input_invalid" ? "work_input_invalid" : "work_item_not_found"
        );
      }
      const packageFacts = packageCheck.facts;

      const concurrency = this.repository.getConcurrency(command.projectId, command.workItem);

      let membership: AssignmentMembershipFacts | undefined;
      if (command.target.kind === "human") {
        membership = this.membershipPort.getMembershipFacts(
          command.projectId,
          command.target.humanPrincipalId
        );
        if (!membership) {
          // Unknown principal — present inactive facts so policy returns work_human_not_member
          // or work_input_invalid rather than inventing a successful assign.
          membership = {
            projectId: command.projectId,
            humanPrincipalId: command.target.humanPrincipalId,
            membershipActive: false
          };
        }
      }

      let host: AssignmentHostFacts | undefined;
      if (command.target.kind === "exact_host") {
        host = this.hostPort.getHostFacts(command.projectId, command.target.hostId);
      }

      const decision = decideAssignmentUpdate({
        command,
        concurrency,
        packageFacts,
        membership,
        host,
        now: this.clock()
      });
      if (!decision.ok) {
        deny(decision.code, decision.message);
      }

      const stored = this.repository.applyCasUpdate({
        record: decision.record,
        expectedRevision: command.expectedRevision
      });

      const display = this.projectOne(command.projectId, command.workItem, stored, packageFacts);
      return {
        record: stored,
        previousRevision: decision.previousRevision,
        display
      };
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  /** Read one assignment projection (revision 0 + unassigned when no durable row). */
  getAssignment(
    actor: HumanAuthContext,
    projectId: string,
    workItemInput: unknown
  ): AssignmentDisplayProjection {
    try {
      const context = humanAuthContextSchema.parse(actor);
      const pid = humanProjectIdSchema.parse(projectId);
      this.assertCanView(context, pid);
      const workItem = workItemRefSchema.parse(workItemInput);
      const packageFacts = this.packagePort.resolveWorkItem(workItem);
      const record = this.repository.get(pid, workItem);
      return this.projectOne(pid, workItem, record, packageFacts);
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  /**
   * Batch read for a canvas/project. Prefer `workItems` for exact refs (up to batch max);
   * otherwise page durable rows for the project (optionally canvas-scoped).
   * Work items without rows are included when `workItems` is supplied (revision 0).
   */
  listAssignments(
    actor: HumanAuthContext,
    projectId: string,
    query: {
      canvasId?: string;
      workItems?: unknown[];
      limit?: number;
      cursor?: number;
    } = {}
  ): AssignmentListResult {
    try {
      const context = humanAuthContextSchema.parse(actor);
      const pid = humanProjectIdSchema.parse(projectId);
      this.assertCanView(context, pid);

      const limit = workAssignmentBatchLimitSchema.parse(query.limit ?? WORK_ASSIGNMENT_BATCH_MAX);
      const cursor = query.cursor ?? 0;
      if (!Number.isSafeInteger(cursor) || cursor < 0) {
        deny("work_input_invalid");
      }

      if (query.workItems !== undefined) {
        if (query.workItems.length > WORK_ASSIGNMENT_BATCH_MAX) {
          deny("work_input_invalid", "Work item batch exceeds maximum size.");
        }
        const workItems = query.workItems.map((item) => workItemRefSchema.parse(item));
        if (query.canvasId !== undefined) {
          for (const workItem of workItems) {
            if (workItem.canvasId !== query.canvasId) {
              deny("work_input_invalid", "Work item canvas does not match list canvas filter.");
            }
          }
        }
        const records = this.repository.getMany(pid, workItems);
        const byKey = new Map(
          records.map((record) => [workItemStableKey(record.workItem), record] as const)
        );
        const items = workItems.map((workItem) => {
          const packageFacts = this.packagePort.resolveWorkItem(workItem);
          return this.projectOne(
            pid,
            workItem,
            byKey.get(workItemStableKey(workItem)),
            packageFacts
          );
        });
        return { items, nextCursor: null };
      }

      const records = this.repository.listByProject(pid, {
        canvasId: query.canvasId,
        limit,
        offset: cursor
      });
      const items = records.map((record) => {
        const packageFacts = this.packagePort.resolveWorkItem(record.workItem);
        return this.projectOne(pid, record.workItem, record, packageFacts);
      });
      const nextCursor = items.length === limit ? cursor + items.length : null;
      return { items, nextCursor };
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  /**
   * Eligible human members (active) and, for Block work items, Host facts that are
   * authorized and capability-compatible for UI selection. Never used as dispatch authority.
   */
  listEligibleAssignees(
    actor: HumanAuthContext,
    projectId: string,
    workItemInput: unknown,
    query: {
      humanLimit?: number;
      humanCursor?: number;
      hostLimit?: number;
      hostCursor?: number;
    } = {}
  ): EligibleAssigneesResult {
    try {
      const context = humanAuthContextSchema.parse(actor);
      const pid = humanProjectIdSchema.parse(projectId);
      this.assertCanView(context, pid);
      const workItem = workItemRefSchema.parse(workItemInput);

      const packageCheck = validateWorkItemRef(this.packagePort, workItem);
      if (!packageCheck.ok) {
        deny(
          packageCheck.code === "work_input_invalid" ? "work_input_invalid" : "work_item_not_found"
        );
      }
      const packageFacts = packageCheck.facts;

      const humanLimit = workAssignmentBatchLimitSchema.parse(query.humanLimit ?? 50);
      const humanCursor = query.humanCursor ?? 0;
      if (!Number.isSafeInteger(humanCursor) || humanCursor < 0) {
        deny("work_input_invalid");
      }
      const humans = this.membershipPort.listActiveMemberFacts(pid, humanLimit, humanCursor);
      const nextHumanCursor = humans.length === humanLimit ? humanCursor + humans.length : null;

      let hosts: AssignmentHostFacts[] = [];
      let nextHostCursor: number | null = null;
      if (workItem.kind === "block") {
        const hostLimit = workAssignmentBatchLimitSchema.parse(query.hostLimit ?? 50);
        const hostCursor = query.hostCursor ?? 0;
        if (!Number.isSafeInteger(hostCursor) || hostCursor < 0) {
          deny("work_input_invalid");
        }
        hosts = this.hostPort.listHostFacts(pid, {
          requiredCapabilities: packageFacts.requiredCapabilities,
          limit: hostLimit,
          offset: hostCursor
        });
        nextHostCursor = hosts.length === hostLimit ? hostCursor + hosts.length : null;
      }

      return {
        workItem,
        packageFacts,
        humans,
        hosts,
        nextHumanCursor,
        nextHostCursor
      };
    } catch (error) {
      mapRepositoryError(error);
    }
  }

  private assertCanView(context: HumanAuthContext, projectId: string): void {
    const decision = authorizeHumanAction({
      action: "view_project",
      subject: { kind: "human", context },
      facts: { targetProjectId: projectId }
    });
    if (!decision.allowed) {
      deny(mapHumanAuthCode(decision.code));
    }
  }

  private projectOne(
    projectId: string,
    workItem: WorkItemRef,
    record: AssignmentRecord | undefined,
    packageFacts: WorkItemPackageFacts
  ): AssignmentDisplayProjection {
    const target = record?.target ?? { kind: "unassigned" as const };
    let membership: AssignmentMembershipFacts | undefined;
    if (target.kind === "human") {
      membership = this.membershipPort.getMembershipFacts(projectId, target.humanPrincipalId);
      if (!membership) {
        membership = {
          projectId,
          humanPrincipalId: target.humanPrincipalId,
          membershipActive: false
        };
      }
    }
    let host: AssignmentHostFacts | undefined;
    if (target.kind === "exact_host") {
      host = this.hostPort.getHostFacts(projectId, target.hostId);
    }
    const activeDispatch = this.resolveActiveDispatch?.({ projectId, workItem });
    return projectAssignmentDisplay({
      projectId,
      workItem,
      record,
      packageFacts,
      membership,
      host,
      activeDispatch
    });
  }
}

function workItemStableKey(workItem: WorkItemRef): string {
  if (workItem.kind === "task") {
    return `task:${workItem.canvasId}:${workItem.taskId}`;
  }
  return `block:${workItem.canvasId}:${workItem.blockRef}`;
}
