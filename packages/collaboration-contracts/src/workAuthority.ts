import { opaqueIdentifierSchema } from "@planweave-ai/distributed-protocol";
import { z } from "zod";
import { executionTargetReadModelSchema } from "./executionTarget.js";
import {
  hostAuthorizationLeaseFactSchema,
  hostAuthorizationReadModelSchema
} from "./hostAuthorization.js";
import {
  collaborationRevisionSchema,
  collaborationWorkScopeSchema,
  responsibilityReadModelSchema
} from "./responsibility.js";
import { reviewAssignmentReadModelSchema } from "./review.js";
import { timestampSchema } from "./primitives.js";

/**
 * Independent CAS counters for responsibility, reviewer, and Host execution target.
 * Mutations on one authority never rewrite the other counters.
 */
export const workAuthorityRevisionsSchema = z
  .object({
    responsibilityRevision: collaborationRevisionSchema,
    reviewerRevision: collaborationRevisionSchema,
    executionTargetRevision: collaborationRevisionSchema
  })
  .strict();
export type WorkAuthorityRevisions = z.infer<typeof workAuthorityRevisionsSchema>;

/**
 * Safe lease projection for UI. Never carries lease secrets or filesystem paths.
 * Selection-time Hosts usually report `none`; active remote attempts report lifecycle.
 */
export const workAuthorityLeaseProjectionSchema = hostAuthorizationLeaseFactSchema;
export type WorkAuthorityLeaseProjection = z.infer<typeof workAuthorityLeaseProjectionSchema>;

/**
 * Redacted Host selection status for one exact Block execution target.
 * Authorization reason is Server-owned; Desktop must not invent ACL from URLs or paths.
 */
export const workAuthoritySelectedHostSchema = z
  .object({
    hostId: opaqueIdentifierSchema,
    /** Selection readiness for the current target (not a substitute for dispatch-time lease gate). */
    availabilityReason: z.enum([
      "ready",
      "unassigned",
      "automatic_pending_selection",
      "host_missing",
      "host_revoked",
      "host_offline",
      "host_at_capacity",
      "host_capability_mismatch",
      "host_not_authorized"
    ]),
    lease: workAuthorityLeaseProjectionSchema,
    /** Present only when Server evaluated a concrete Host; never includes secrets. */
    authorization: hostAuthorizationReadModelSchema.nullable()
  })
  .strict();
export type WorkAuthoritySelectedHost = z.infer<typeof workAuthoritySelectedHostSchema>;

/**
 * Typed redacted projection for one Task or one exact Task#Block.
 * Responsibility and reviewer are human-only; Host execution target is Block-only.
 */
export const workAuthorityProjectionSchema = z
  .object({
    schemaVersion: z.literal("work-authority/v1"),
    scope: collaborationWorkScopeSchema,
    responsibility: responsibilityReadModelSchema,
    reviewer: reviewAssignmentReadModelSchema,
    /** Always null for Task scopes; Block scopes always include a projection (may be unassigned). */
    executionTarget: executionTargetReadModelSchema.nullable(),
    revisions: workAuthorityRevisionsSchema,
    selectedHost: workAuthoritySelectedHostSchema.nullable(),
    evaluatedAt: timestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scope.kind === "task" && value.executionTarget !== null) {
      context.addIssue({
        code: "custom",
        message: "task_scope_cannot_carry_execution_target",
        path: ["executionTarget"]
      });
    }
    if (value.scope.kind === "task" && value.selectedHost !== null) {
      context.addIssue({
        code: "custom",
        message: "task_scope_cannot_carry_selected_host",
        path: ["selectedHost"]
      });
    }
    if (value.scope.kind === "block" && value.executionTarget === null) {
      context.addIssue({
        code: "custom",
        message: "block_scope_requires_execution_target_projection",
        path: ["executionTarget"]
      });
    }
  });
export type WorkAuthorityProjection = z.infer<typeof workAuthorityProjectionSchema>;

/** Desktop/Server wire body is the full projection; empty records use revision 0. */
export const workAuthorityProjectionWireSchema = workAuthorityProjectionSchema;
export type WorkAuthorityProjectionWire = WorkAuthorityProjection;
