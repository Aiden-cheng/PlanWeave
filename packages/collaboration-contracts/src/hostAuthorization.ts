import {
  capabilitiesSchema,
  dispatchIdSchema,
  executionAttemptIdSchema,
  leaseIdSchema,
  opaqueIdentifierSchema
} from "@planweave-ai/distributed-protocol";
import { z } from "zod";
import { COLLABORATION_REVISION_MAX, HOST_AUTHORIZATION_CAPABILITIES_MAX } from "./limits.js";
import { exactBlockExecutionScopeSchema } from "./executionTarget.js";
import { timestampSchema, workspaceIdSchema } from "./primitives.js";

export const hostAuthorizationSchemaVersion = "host-authorization/v1" as const;
export const hostAuthorizationSchemaVersionSchema = z.literal(hostAuthorizationSchemaVersion);
export type HostAuthorizationSchemaVersion = z.infer<typeof hostAuthorizationSchemaVersionSchema>;

const revisionSchema = z.number().int().nonnegative().max(COLLABORATION_REVISION_MAX);

const aclFactSchema = z.object({ revision: revisionSchema, allowed: z.boolean() }).strict();

export const hostAuthorizationLeaseFactSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("none"), leaseId: z.null(), expiresAt: z.null() }).strict(),
  z
    .object({ status: z.literal("active"), leaseId: leaseIdSchema, expiresAt: timestampSchema })
    .strict(),
  z
    .object({ status: z.literal("expired"), leaseId: leaseIdSchema, expiresAt: timestampSchema })
    .strict(),
  z
    .object({ status: z.literal("revoked"), leaseId: leaseIdSchema, expiresAt: timestampSchema })
    .strict()
]);
export type HostAuthorizationLeaseFact = z.infer<typeof hostAuthorizationLeaseFactSchema>;

const attemptIdentityShape = {
  dispatchId: dispatchIdSchema,
  executionAttemptId: executionAttemptIdSchema
};
export const hostAuthorizationAttemptFactSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("none"), dispatchId: z.null(), executionAttemptId: z.null() })
    .strict(),
  z.object({ status: z.literal("prepared"), ...attemptIdentityShape }).strict(),
  z.object({ status: z.literal("reserved"), ...attemptIdentityShape }).strict(),
  z.object({ status: z.literal("activated"), ...attemptIdentityShape }).strict(),
  z.object({ status: z.literal("running"), ...attemptIdentityShape }).strict(),
  z.object({ status: z.literal("awaiting_writeback"), ...attemptIdentityShape }).strict(),
  z.object({ status: z.literal("interrupted"), ...attemptIdentityShape }).strict(),
  z.object({ status: z.literal("completed"), ...attemptIdentityShape }).strict(),
  z.object({ status: z.literal("failed"), ...attemptIdentityShape }).strict(),
  z.object({ status: z.literal("cancelled"), ...attemptIdentityShape }).strict()
]);
export type HostAuthorizationAttemptFact = z.infer<typeof hostAuthorizationAttemptFactSchema>;

export const hostAuthorizationCurrentRevisionsSchema = z
  .object({
    responsibilityRevision: revisionSchema,
    reviewerRevision: revisionSchema,
    executionTargetRevision: revisionSchema
  })
  .strict();
export type HostAuthorizationCurrentRevisions = z.infer<
  typeof hostAuthorizationCurrentRevisionsSchema
>;

/** Server-only facts; no bearer, credential, filesystem path, or command fields are allowed. */
export const hostAuthorizationFactsSchema = z
  .object({
    schemaVersion: hostAuthorizationSchemaVersionSchema,
    scope: exactBlockExecutionScopeSchema,
    hostId: opaqueIdentifierSchema,
    hostWorkspaceId: workspaceIdSchema,
    workspaceAcl: aclFactSchema,
    projectAcl: aclFactSchema,
    canvasAcl: aclFactSchema,
    requiredCapabilities: capabilitiesSchema.max(HOST_AUTHORIZATION_CAPABILITIES_MAX),
    advertisedCapabilities: capabilitiesSchema.max(HOST_AUTHORIZATION_CAPABILITIES_MAX),
    revoked: z.boolean(),
    online: z.boolean(),
    capacityRemaining: z.number().int().nonnegative(),
    lease: hostAuthorizationLeaseFactSchema,
    attempt: hostAuthorizationAttemptFactSchema,
    expectedRevisions: hostAuthorizationCurrentRevisionsSchema,
    currentRevisions: hostAuthorizationCurrentRevisionsSchema,
    evaluatedAt: timestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.hostWorkspaceId !== value.scope.workspaceId) {
      context.addIssue({ code: "custom", message: "cross_workspace_host_fact" });
    }
  });
export type HostAuthorizationFacts = z.infer<typeof hostAuthorizationFactsSchema>;

export const hostAuthorizationDecisionReasonSchema = z.enum([
  "authorized",
  "cross_workspace",
  "workspace_acl_denied",
  "project_acl_denied",
  "canvas_acl_denied",
  "host_missing",
  "host_revoked",
  "host_offline",
  "host_at_capacity",
  "capability_mismatch",
  "lease_missing",
  "attempt_mismatch",
  "stale_responsibility_revision",
  "stale_reviewer_revision",
  "stale_execution_target_revision"
]);
export type HostAuthorizationDecisionReason = z.infer<typeof hostAuthorizationDecisionReasonSchema>;

const deniedReasonSchema = hostAuthorizationDecisionReasonSchema.exclude(["authorized"]);
export const hostAuthorizationDecisionSchema = z
  .discriminatedUnion("decision", [
    z
      .object({
        schemaVersion: hostAuthorizationSchemaVersionSchema,
        decision: z.literal("allow"),
        scope: exactBlockExecutionScopeSchema,
        hostId: opaqueIdentifierSchema,
        hostWorkspaceId: workspaceIdSchema,
        reason: z.literal("authorized"),
        currentRevisions: hostAuthorizationCurrentRevisionsSchema,
        evaluatedAt: timestampSchema,
        facts: hostAuthorizationFactsSchema
      })
      .strict(),
    z
      .object({
        schemaVersion: hostAuthorizationSchemaVersionSchema,
        decision: z.literal("deny"),
        scope: exactBlockExecutionScopeSchema,
        hostId: opaqueIdentifierSchema,
        hostWorkspaceId: workspaceIdSchema,
        reason: deniedReasonSchema,
        currentRevisions: hostAuthorizationCurrentRevisionsSchema,
        evaluatedAt: timestampSchema,
        facts: hostAuthorizationFactsSchema.optional()
      })
      .strict()
  ])
  .superRefine((value, context) => {
    if (value.hostWorkspaceId !== value.scope.workspaceId) {
      context.addIssue({ code: "custom", message: "cross_workspace_host_decision" });
    }
    if (value.decision === "allow") {
      const factsResult = hostAuthorizationFactsSchema.safeParse(value.facts);
      if (!factsResult.success) {
        context.addIssue({ code: "custom", message: "invalid_authorization_facts" });
        return;
      }
      const facts = factsResult.data;
      const leaseResult = hostAuthorizationLeaseFactSchema.safeParse(facts.lease);
      const attemptResult = hostAuthorizationAttemptFactSchema.safeParse(facts.attempt);
      if (!leaseResult.success || !attemptResult.success) {
        context.addIssue({ code: "custom", message: "invalid_authorization_lifecycle_facts" });
        return;
      }
      const capabilitiesCompatible = facts.requiredCapabilities.every((capability) =>
        facts.advertisedCapabilities.includes(capability)
      );
      const activeAttempt = ["reserved", "activated", "running", "awaiting_writeback"].includes(
        attemptResult.data.status
      );
      if (
        facts.hostId !== value.hostId ||
        facts.hostWorkspaceId !== value.hostWorkspaceId ||
        facts.scope.workspaceId !== value.scope.workspaceId ||
        facts.scope.projectId !== value.scope.projectId ||
        facts.scope.canvasId !== value.scope.canvasId ||
        facts.scope.blockRef !== value.scope.blockRef ||
        facts.revoked ||
        !facts.online ||
        facts.capacityRemaining < 1 ||
        !facts.workspaceAcl.allowed ||
        !facts.projectAcl.allowed ||
        !facts.canvasAcl.allowed ||
        !capabilitiesCompatible ||
        leaseResult.data.status !== "active" ||
        !activeAttempt ||
        facts.expectedRevisions.responsibilityRevision !==
          facts.currentRevisions.responsibilityRevision ||
        facts.expectedRevisions.reviewerRevision !== facts.currentRevisions.reviewerRevision ||
        facts.expectedRevisions.executionTargetRevision !==
          facts.currentRevisions.executionTargetRevision ||
        value.currentRevisions.responsibilityRevision !==
          facts.currentRevisions.responsibilityRevision ||
        value.currentRevisions.reviewerRevision !== facts.currentRevisions.reviewerRevision ||
        value.currentRevisions.executionTargetRevision !==
          facts.currentRevisions.executionTargetRevision
      ) {
        context.addIssue({ code: "custom", message: "allow_decision_conflicts_with_facts" });
      }
    }
  });
export type HostAuthorizationDecision = z.infer<typeof hostAuthorizationDecisionSchema>;

/** Safe read model: decision/reason only, never authorization material or paths. */
export const hostAuthorizationReadModelSchema = z
  .object({
    schemaVersion: hostAuthorizationSchemaVersionSchema,
    scope: exactBlockExecutionScopeSchema,
    hostId: opaqueIdentifierSchema,
    decision: z.enum(["allow", "deny"]),
    reason: hostAuthorizationDecisionReasonSchema,
    currentRevisions: hostAuthorizationCurrentRevisionsSchema,
    evaluatedAt: timestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.decision === "allow") !== (value.reason === "authorized")) {
      context.addIssue({ code: "custom", message: "authorization_reason_decision_mismatch" });
    }
  });
export type HostAuthorizationReadModel = z.infer<typeof hostAuthorizationReadModelSchema>;

export const hostAuthorizationFactsProjectionSchema = hostAuthorizationReadModelSchema;
