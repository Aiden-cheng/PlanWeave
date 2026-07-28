import { opaqueIdentifierSchema } from "@planweave-ai/distributed-protocol";
import { z } from "zod";
import {
  WORK_ASSIGNMENT_BATCH_MAX,
  WORK_HOST_DISPLAY_NAME_MAX_LENGTH,
  WORK_HOST_DISPLAY_NAME_MIN_LENGTH
} from "./limits.js";
import {
  actorRefSchema,
  humanAssignReasonSchema,
  humanDisplayNameSchema,
  humanPrincipalIdSchema,
  humanProjectIdSchema,
  timestampSchema,
  workItemRefSchema
} from "./primitives.js";

/**
 * @deprecated Legacy migration input only. New writes must use the independent
 * responsibility, review assignment, and execution target contracts.
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

export const assignmentAvailabilitySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), reason: z.literal("ready") }).strict(),
  z.object({ status: z.literal("unassigned"), reason: z.literal("unassigned") }).strict(),
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
    capabilitiesSatisfied: z.boolean().optional()
  })
  .strict();

/** Read-model projection for Task/Block assignment views. */
export const assignmentDisplayProjectionSchema = z
  .object({
    projectId: humanProjectIdSchema,
    workItem: workItemRefSchema,
    target: assignmentTargetSchema,
    revision: z.number().int().nonnegative(),
    updatedBy: actorRefSchema.optional(),
    updatedAt: timestampSchema.optional(),
    reason: humanAssignReasonSchema.optional(),
    human: assignmentHumanDisplaySchema.optional(),
    host: assignmentHostDisplaySchema.optional(),
    availability: assignmentAvailabilitySchema,
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
 * Wire mutation command. Actor is injected by Server from the device bearer;
 * Desktop never sends `actor` or auth context blobs.
 */
export const assignmentUpdateWireCommandSchema = z
  .object({
    workItem: workItemRefSchema,
    target: assignmentTargetSchema,
    expectedRevision: z.number().int().nonnegative(),
    reason: humanAssignReasonSchema.optional()
  })
  .strict();
export type AssignmentUpdateWireCommand = z.infer<typeof assignmentUpdateWireCommandSchema>;

export const assignmentListPageSchema = z
  .object({
    items: z.array(assignmentDisplayProjectionSchema).max(WORK_ASSIGNMENT_BATCH_MAX),
    nextCursor: z.number().int().nonnegative().nullable()
  })
  .strict();
export type AssignmentListPage = z.infer<typeof assignmentListPageSchema>;

export const assignmentListQuerySchema = z
  .object({
    canvasId: opaqueIdentifierSchema.optional(),
    workItems: z.array(workItemRefSchema).max(WORK_ASSIGNMENT_BATCH_MAX).optional(),
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(WORK_ASSIGNMENT_BATCH_MAX).default(50)
  })
  .strict();
export type AssignmentListQuery = z.infer<typeof assignmentListQuerySchema>;

export const assignmentMembershipFactsSchema = z
  .object({
    projectId: humanProjectIdSchema,
    humanPrincipalId: humanPrincipalIdSchema,
    membershipActive: z.boolean(),
    displayName: humanDisplayNameSchema.optional()
  })
  .strict();

export const assignmentHostFactsSchema = z
  .object({
    workspaceId: opaqueIdentifierSchema,
    projectId: humanProjectIdSchema,
    hostId: opaqueIdentifierSchema,
    exists: z.boolean(),
    revoked: z.boolean(),
    authorizedForProject: z.boolean(),
    online: z.boolean(),
    ready: z.boolean(),
    capabilities: z.array(z.string().min(1)).max(128),
    displayName: z
      .string()
      .min(WORK_HOST_DISPLAY_NAME_MIN_LENGTH)
      .max(WORK_HOST_DISPLAY_NAME_MAX_LENGTH)
      .optional(),
    capacityRemaining: z.number().int().nonnegative().optional()
  })
  .strict();

export const eligibleAssigneesResponseSchema = z
  .object({
    workItem: workItemRefSchema,
    humans: z.array(assignmentMembershipFactsSchema).max(100),
    hosts: z.array(assignmentHostFactsSchema).max(100),
    nextHumanCursor: z.number().int().nonnegative().nullable(),
    nextHostCursor: z.number().int().nonnegative().nullable()
  })
  .strict();
export type EligibleAssigneesResponse = z.infer<typeof eligibleAssigneesResponseSchema>;
