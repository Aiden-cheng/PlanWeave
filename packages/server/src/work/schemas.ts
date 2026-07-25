import { blockRefSchema, opaqueIdentifierSchema } from "@planweave-ai/distributed-protocol";
import { z } from "zod";
import {
  actorRefSchema,
  humanAssignReasonSchema,
  humanAuthContextSchema,
  humanDisplayNameSchema,
  humanPrincipalIdSchema,
  humanProjectIdSchema
} from "../identity/schemas.js";
import {
  WORK_ASSIGNMENT_BATCH_MAX,
  WORK_HOST_DISPLAY_NAME_MAX_LENGTH,
  WORK_HOST_DISPLAY_NAME_MIN_LENGTH
} from "./limits.js";

const timestampSchema = z.iso.datetime();

/**
 * Project-scoped WorkItemRef: Task aggregation or portable Block ref.
 * Project id is the assignment key outside this value (repository/API layer).
 * Never a filesystem path; never mutates Plan Package.
 */
export const workItemRefSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("task"),
      canvasId: opaqueIdentifierSchema,
      taskId: opaqueIdentifierSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("block"),
      canvasId: opaqueIdentifierSchema,
      blockRef: blockRefSchema
    })
    .strict()
]);
export type WorkItemRef = z.infer<typeof workItemRefSchema>;

/**
 * Assignment target is a strict discriminated union — never a free-form assignee string
 * and never nullable field combinations that mask target kind.
 *
 * - `unassigned`: explicit no owner (durable unassign still bumps revision).
 * - `human`: current project member (membership checked by policy, not schema alone).
 * - `exact_host`: one concrete Agent Host id (Block only; Host path separate from human).
 * - `automatic_host`: Block-only automatic selection; requirements stay on the Block
 *   in Plan Package — this target does NOT copy capability lists.
 */
export const assignmentTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unassigned") }).strict(),
  z
    .object({
      kind: z.literal("human"),
      humanPrincipalId: humanPrincipalIdSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("exact_host"),
      hostId: opaqueIdentifierSchema
    })
    .strict(),
  z.object({ kind: z.literal("automatic_host") }).strict()
]);
export type AssignmentTarget = z.infer<typeof assignmentTargetSchema>;

/** Machine targets invalid for Task work items. */
export function isMachineAssignmentTarget(target: AssignmentTarget): boolean {
  return target.kind === "exact_host" || target.kind === "automatic_host";
}

export function assertTargetAllowedForWorkItem(
  workItem: WorkItemRef,
  target: AssignmentTarget
): { ok: true } | { ok: false; message: string } {
  if (workItem.kind === "task" && isMachineAssignmentTarget(target)) {
    return {
      ok: false,
      message:
        "Tasks may only be unassigned or assigned to a human member; Host targets are invalid."
    };
  }
  return { ok: true };
}

/**
 * Durable assignment record (coordination metadata only).
 * Does not store task titles, prompts, Block lifecycle, Host presence, or capability copies.
 * `revision` is always positive for a stored row; revision 0 means no row yet.
 */
export const assignmentRecordSchema = z
  .object({
    projectId: humanProjectIdSchema,
    workItem: workItemRefSchema,
    target: assignmentTargetSchema,
    revision: z.number().int().positive(),
    updatedBy: actorRefSchema,
    updatedAt: timestampSchema,
    reason: humanAssignReasonSchema.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    const kindOk = assertTargetAllowedForWorkItem(value.workItem, value.target);
    if (!kindOk.ok) {
      ctx.addIssue({
        code: "custom",
        message: kindOk.message,
        path: ["target"]
      });
    }
  });
export type AssignmentRecord = z.infer<typeof assignmentRecordSchema>;

/**
 * Optimistic concurrency command. `expectedRevision` is 0 when no durable assignment exists.
 * Actor is a concrete human auth context (authorization), not a display ActorRef.
 * Does not mutate Plan Package.
 */
export const assignmentUpdateCommandSchema = z
  .object({
    projectId: humanProjectIdSchema,
    workItem: workItemRefSchema,
    target: assignmentTargetSchema,
    expectedRevision: z.number().int().nonnegative(),
    actor: humanAuthContextSchema,
    reason: humanAssignReasonSchema.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.actor.projectId !== value.projectId) {
      ctx.addIssue({
        code: "custom",
        message: "Actor projectId must match assignment projectId",
        path: ["actor", "projectId"]
      });
    }
    const kindOk = assertTargetAllowedForWorkItem(value.workItem, value.target);
    if (!kindOk.ok) {
      ctx.addIssue({
        code: "custom",
        message: kindOk.message,
        path: ["target"]
      });
    }
  });
export type AssignmentUpdateCommand = z.infer<typeof assignmentUpdateCommandSchema>;

export const workAssignmentBatchLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(WORK_ASSIGNMENT_BATCH_MAX);

/**
 * Availability / readiness for UI. Invalid means the durable target no longer
 * satisfies membership/authorization/capability facts; unavailable means the target
 * still structurally valid but not currently ready (e.g. Host offline).
 * Never silently retarget when a member/Host disappears.
 */
export const assignmentAvailabilityReasonSchema = z.enum([
  "unassigned",
  "human_membership_inactive",
  "host_missing",
  "host_revoked",
  "host_not_authorized",
  "host_capability_mismatch",
  "host_offline",
  "host_at_capacity",
  "work_item_missing",
  "ready",
  "automatic_pending_selection"
]);
export type AssignmentAvailabilityReason = z.infer<typeof assignmentAvailabilityReasonSchema>;

export const assignmentAvailabilitySchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ready"),
      reason: z.literal("ready")
    })
    .strict(),
  z
    .object({
      status: z.literal("unassigned"),
      reason: z.literal("unassigned")
    })
    .strict(),
  z
    .object({
      status: z.literal("pending"),
      reason: z.literal("automatic_pending_selection")
    })
    .strict(),
  z
    .object({
      status: z.literal("invalid"),
      reason: assignmentAvailabilityReasonSchema.exclude([
        "ready",
        "unassigned",
        "automatic_pending_selection",
        "host_offline",
        "host_at_capacity"
      ])
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      reason: z.enum(["host_offline", "host_at_capacity"])
    })
    .strict()
]);
export type AssignmentAvailability = z.infer<typeof assignmentAvailabilitySchema>;

export const assignmentHumanDisplaySchema = z
  .object({
    humanPrincipalId: humanPrincipalIdSchema,
    displayName: humanDisplayNameSchema,
    membershipActive: z.boolean()
  })
  .strict();
export type AssignmentHumanDisplay = z.infer<typeof assignmentHumanDisplaySchema>;

export const assignmentHostDisplaySchema = z
  .object({
    hostId: opaqueIdentifierSchema,
    displayName: z
      .string()
      .min(WORK_HOST_DISPLAY_NAME_MIN_LENGTH)
      .max(WORK_HOST_DISPLAY_NAME_MAX_LENGTH),
    online: z.boolean(),
    authorizedForProject: z.boolean(),
    revoked: z.boolean(),
    /**
     * Whether Host capabilities satisfy the Block's *current* package requirements.
     * Only meaningful for exact_host on Block; omit rather than invent for other targets.
     */
    capabilitiesSatisfied: z.boolean().optional()
  })
  .strict();
export type AssignmentHostDisplay = z.infer<typeof assignmentHostDisplaySchema>;

/**
 * Read-model projection for Task/Block views. Display-only — never used for auth.
 * Does not duplicate Runtime Block lifecycle or claim state as assignment authority.
 */
export const assignmentDisplayProjectionSchema = z
  .object({
    projectId: humanProjectIdSchema,
    workItem: workItemRefSchema,
    target: assignmentTargetSchema,
    /** 0 when no durable assignment row exists. */
    revision: z.number().int().nonnegative(),
    updatedBy: actorRefSchema.optional(),
    updatedAt: timestampSchema.optional(),
    reason: humanAssignReasonSchema.optional(),
    human: assignmentHumanDisplaySchema.optional(),
    host: assignmentHostDisplaySchema.optional(),
    availability: assignmentAvailabilitySchema,
    /**
     * Optional active remote dispatch snapshot for display. Assignment and dispatch
     * remain separate operations; this never implies reassignment.
     */
    activeDispatch: z
      .object({
        present: z.boolean(),
        hostId: opaqueIdentifierSchema.optional(),
        dispatchId: opaqueIdentifierSchema.optional()
      })
      .strict()
      .optional()
  })
  .strict();
export type AssignmentDisplayProjection = z.infer<typeof assignmentDisplayProjectionSchema>;

/**
 * Pure package facts for one WorkItemRef. Source of truth is Plan Package / compiled graph.
 * Assignment storage must not invent titles, prompts, or capability copies.
 */
export const workItemPackageFactsSchema = z
  .object({
    canvasId: opaqueIdentifierSchema,
    kind: z.enum(["task", "block"]),
    exists: z.boolean(),
    taskId: opaqueIdentifierSchema.optional(),
    blockRef: blockRefSchema.optional(),
    blockType: z.enum(["implementation", "review"]).optional(),
    /**
     * Authoritative portable capabilities from the Block's Plan Package requirements.
     * Empty for Tasks, review blocks without requirements, or missing items.
     * Automatic Host selection must reference this list — never a divergent assignment blob.
     */
    requiredCapabilities: z.array(z.string().min(1)).max(128)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "task") {
      if (value.taskId === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "task facts require taskId",
          path: ["taskId"]
        });
      }
      if (value.blockRef !== undefined || value.blockType !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "task facts must not include block fields",
          path: ["blockRef"]
        });
      }
    }
    if (value.kind === "block") {
      if (value.blockRef === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "block facts require blockRef",
          path: ["blockRef"]
        });
      }
    }
  });
export type WorkItemPackageFacts = z.infer<typeof workItemPackageFactsSchema>;

/** Membership facts for a human assignment target (identity is truth source). */
export const assignmentMembershipFactsSchema = z
  .object({
    projectId: humanProjectIdSchema,
    humanPrincipalId: humanPrincipalIdSchema,
    membershipActive: z.boolean(),
    displayName: humanDisplayNameSchema.optional()
  })
  .strict();
export type AssignmentMembershipFacts = z.infer<typeof assignmentMembershipFactsSchema>;

/**
 * Host facts for exact Host assignment / readiness display.
 * Authorization-to-serve-project is an application fact (not assumed global).
 * Capabilities are current Host advertisement, not stored on the assignment row.
 */
export const assignmentHostFactsSchema = z
  .object({
    projectId: humanProjectIdSchema,
    hostId: opaqueIdentifierSchema,
    exists: z.boolean(),
    revoked: z.boolean(),
    authorizedForProject: z.boolean(),
    online: z.boolean(),
    capabilities: z.array(z.string().min(1)).max(128),
    displayName: z
      .string()
      .min(WORK_HOST_DISPLAY_NAME_MIN_LENGTH)
      .max(WORK_HOST_DISPLAY_NAME_MAX_LENGTH)
      .optional(),
    /** Remaining capacity slots when known; omit if unknown rather than invent. */
    capacityRemaining: z.number().int().nonnegative().optional()
  })
  .strict();
export type AssignmentHostFacts = z.infer<typeof assignmentHostFactsSchema>;

/** Current durable assignment concurrency snapshot. */
export const assignmentConcurrencyFactsSchema = z
  .object({
    currentRevision: z.number().int().nonnegative(),
    current: assignmentRecordSchema.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.current === undefined) {
      if (value.currentRevision !== 0) {
        ctx.addIssue({
          code: "custom",
          message: "missing assignment record requires currentRevision 0",
          path: ["currentRevision"]
        });
      }
      return;
    }
    if (value.current.revision !== value.currentRevision) {
      ctx.addIssue({
        code: "custom",
        message: "currentRevision must match current.revision",
        path: ["currentRevision"]
      });
    }
  });
export type AssignmentConcurrencyFacts = z.infer<typeof assignmentConcurrencyFactsSchema>;
