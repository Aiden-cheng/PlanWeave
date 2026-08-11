import { z } from "zod";
import { CONTENT_VERSION_MAX_REASON_LENGTH } from "./limits.js";
import { aclRevisionSchema } from "./projectAccess.js";
import { canvasScopeRefSchema, deviceSessionIdSchema } from "./primitives.js";
import {
  authoritativeContentHeadSchema,
  completedContentVersionRefSchema,
  contentVersionAcknowledgementSchema
} from "./contentVersion.js";

/**
 * Untrusted device input for discovering the current authoritative content head.
 * Actor, workspace scope, ACL state, and device identity are server-derived.
 */
export const contentVersionAuthorityDiscoveryRequestSchema = z
  .object({
    projectId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    canvasId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    localReplica: completedContentVersionRefSchema.nullable(),
    knownRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable()
  })
  .strict();
export type ContentVersionAuthorityDiscoveryRequest = z.infer<
  typeof contentVersionAuthorityDiscoveryRequestSchema
>;

/** Server-only envelope after authentication and exact canvas ACL resolution. */
export const authorizedContentVersionAuthorityDiscoverySchema = z
  .object({
    request: contentVersionAuthorityDiscoveryRequestSchema,
    scope: canvasScopeRefSchema,
    deviceSessionId: deviceSessionIdSchema,
    aclRevision: aclRevisionSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.request.projectId !== value.scope.projectId ||
      value.request.canvasId !== value.scope.canvasId
    ) {
      context.addIssue({ code: "custom", message: "authorized_content_authority_scope_mismatch" });
    }
  });
export type AuthorizedContentVersionAuthorityDiscovery = z.infer<
  typeof authorizedContentVersionAuthorityDiscoverySchema
>;

export const contentReplicaStatusSchema = z.enum([
  "in_sync",
  "behind",
  "diverged",
  "snapshot_required"
]);
export type ContentReplicaStatus = z.infer<typeof contentReplicaStatusSchema>;

export const contentVersionRecoveryActionSchema = z.enum([
  "none",
  "fetch_head",
  "await_initial_publish"
]);
export type ContentVersionRecoveryAction = z.infer<typeof contentVersionRecoveryActionSchema>;

/**
 * Renderer-safe authoritative state for a device. It contains no bytes, working
 * directories, physical paths, or credentials; `fetch_head` uses the returned
 * completed reference with the existing bounded content fetch endpoint.
 */
export const contentVersionAuthorityDiscoveryResultSchema = z
  .object({
    authoritativeHead: authoritativeContentHeadSchema.nullable(),
    localReplica: completedContentVersionRefSchema.nullable(),
    lastAcknowledgement: contentVersionAcknowledgementSchema.nullable(),
    replicaStatus: contentReplicaStatusSchema,
    recoveryAction: contentVersionRecoveryActionSchema,
    canPublishInitial: z.boolean(),
    canMaterialize: z.boolean(),
    canRecover: z.boolean()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.replicaStatus === "in_sync") {
      if (value.authoritativeHead === null || value.localReplica === null) {
        context.addIssue({ code: "custom", message: "in_sync_requires_head_and_replica" });
      } else if (value.authoritativeHead.content.versionId !== value.localReplica.versionId) {
        context.addIssue({ code: "custom", message: "in_sync_requires_matching_version" });
      }
      if (value.recoveryAction !== "none") {
        context.addIssue({ code: "custom", message: "in_sync_requires_no_recovery" });
      }
    }
    if (value.authoritativeHead === null && value.recoveryAction !== "await_initial_publish") {
      context.addIssue({ code: "custom", message: "headless_authority_requires_initial_publish" });
    }
    if (
      value.authoritativeHead !== null &&
      value.replicaStatus !== "in_sync" &&
      value.recoveryAction !== "fetch_head"
    ) {
      context.addIssue({ code: "custom", message: "stale_replica_requires_head_fetch" });
    }
    if (value.canPublishInitial && value.authoritativeHead !== null) {
      context.addIssue({ code: "custom", message: "initial_publish_requires_headless_authority" });
    }
    if (value.canMaterialize !== (value.authoritativeHead !== null)) {
      context.addIssue({ code: "custom", message: "materialization_requires_authoritative_head" });
    }
    if (value.recoveryAction === "fetch_head" && !value.canRecover) {
      context.addIssue({ code: "custom", message: "head_fetch_requires_recovery_capability" });
    }
    if (
      value.recoveryAction === "await_initial_publish" &&
      value.canRecover !== value.canPublishInitial
    ) {
      context.addIssue({ code: "custom", message: "headless_recovery_requires_owner_capability" });
    }
  });
export type ContentVersionAuthorityDiscoveryResult = z.infer<
  typeof contentVersionAuthorityDiscoveryResultSchema
>;

/** Renderer-safe read model: only immutable IDs/digests and redacted action state. */
export const contentVersionDesktopReadModelSchema = z
  .object({
    authoritativeHead: authoritativeContentHeadSchema.nullable(),
    localReplica: completedContentVersionRefSchema.nullable(),
    replicaStatus: contentReplicaStatusSchema,
    lastAcknowledgement: contentVersionAcknowledgementSchema.nullable(),
    canPublishInitial: z.boolean(),
    canMaterialize: z.boolean(),
    canRecover: z.boolean(),
    offlineWriteReason: z.string().trim().min(1).max(CONTENT_VERSION_MAX_REASON_LENGTH).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.replicaStatus === "in_sync") {
      if (value.authoritativeHead === null || value.localReplica === null) {
        context.addIssue({ code: "custom", message: "in_sync_requires_head_and_replica" });
      } else if (value.authoritativeHead.content.versionId !== value.localReplica.versionId) {
        context.addIssue({ code: "custom", message: "in_sync_requires_matching_version" });
      }
    }
    if (
      value.replicaStatus === "snapshot_required" &&
      value.authoritativeHead !== null &&
      !value.canRecover
    ) {
      context.addIssue({
        code: "custom",
        message: "snapshot_required_must_allow_recovery",
        path: ["canRecover"]
      });
    }
    if (value.offlineWriteReason !== null && value.canPublishInitial) {
      context.addIssue({
        code: "custom",
        message: "offline_write_block_cannot_allow_initial_publish"
      });
    }
  });
export type ContentVersionDesktopReadModel = z.infer<typeof contentVersionDesktopReadModelSchema>;

export function contentVersionAuthorityDiscoveryToDesktopReadModel(
  input: ContentVersionAuthorityDiscoveryResult
): ContentVersionDesktopReadModel {
  const authority = contentVersionAuthorityDiscoveryResultSchema.parse(input);
  return contentVersionDesktopReadModelSchema.parse({
    authoritativeHead: authority.authoritativeHead,
    localReplica: authority.localReplica,
    replicaStatus: authority.replicaStatus,
    lastAcknowledgement: authority.lastAcknowledgement,
    canPublishInitial: authority.canPublishInitial,
    canMaterialize: authority.canMaterialize,
    canRecover: authority.canRecover,
    offlineWriteReason: null
  });
}
