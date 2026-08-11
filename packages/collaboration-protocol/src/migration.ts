import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol/browser";
import { z } from "zod";
import {
  timestampSchema,
  workspaceIdentityMigrationSchemaVersionSchema,
  workspaceIdentitySchemaVersion,
  workspaceIdSchema
} from "./primitives.js";

export type IdentityMigrationStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "interrupted"
  | "repair_required"
  | "rolled_back";

export const identityMigrationStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "interrupted",
  "repair_required",
  "rolled_back"
]);

export const identityMigrationStepSchema = z.enum([
  "create_workspace",
  "map_legacy_project",
  "backfill_principals",
  "backfill_memberships",
  "backfill_devices",
  "backfill_hosts",
  "cutover_authoritative_reads",
  "verify_cutover"
]);
export type IdentityMigrationStep = z.infer<typeof identityMigrationStepSchema>;

export const identityMigrationMarkerSchema = z.enum([
  "none",
  "workspace_created",
  "mapping_written",
  "principals_backfilled",
  "memberships_backfilled",
  "devices_backfilled",
  "hosts_backfilled",
  "read_cutover_pending",
  "read_cutover_complete",
  "partial_backfill_failed",
  "rollback_complete"
]);
export type IdentityMigrationMarker = z.infer<typeof identityMigrationMarkerSchema>;

/** Stable project-to-Workspace mapping. The normalized identity is an explicit, persisted key. */
export const legacyProjectWorkspaceMappingSchema = z
  .object({
    schemaVersion: workspaceIdentityMigrationSchemaVersionSchema,
    mappingVersion: z.literal("legacy-project-workspace/v1"),
    legacyProjectId: opaqueIdentifierSchema,
    normalizedLegacyProjectIdentity: z.string().trim().min(1).max(512),
    workspaceId: workspaceIdSchema,
    mappedAt: timestampSchema
  })
  .strict();
export type LegacyProjectWorkspaceMapping = z.infer<typeof legacyProjectWorkspaceMappingSchema>;

/** Persisted migration state; nullable fields are explicit rather than optional. */
export const identityMigrationStateSchema = z
  .object({
    schemaVersion: workspaceIdentityMigrationSchemaVersionSchema,
    migrationId: opaqueIdentifierSchema,
    legacyProjectId: opaqueIdentifierSchema,
    workspaceId: workspaceIdSchema,
    fromVersion: z.number().int().nonnegative(),
    toVersion: z.literal(1),
    step: identityMigrationStepSchema,
    status: identityMigrationStatusSchema,
    interruptionMarker: identityMigrationMarkerSchema,
    authoritativeReadVersion: z.literal(workspaceIdentitySchemaVersion),
    failureCode: z.string().trim().min(1).max(256).nullable(),
    updatedAt: timestampSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    const failed = value.status === "interrupted" || value.status === "repair_required";
    if (failed !== (value.failureCode !== null)) {
      ctx.addIssue({ code: "custom", message: "migration_failure_marker_mismatch" });
    }
    if (value.status === "completed" && value.interruptionMarker !== "read_cutover_complete") {
      ctx.addIssue({ code: "custom", message: "completed_migration_requires_read_cutover" });
    }
    if (value.status === "rolled_back" && value.interruptionMarker !== "rollback_complete") {
      ctx.addIssue({ code: "custom", message: "rolled_back_migration_requires_marker" });
    }
  });
export type IdentityMigrationState = z.infer<typeof identityMigrationStateSchema>;

export const identityMigrationOutcomeSchema = z.enum([
  "resume_from_marker",
  "retry_idempotent",
  "repair_required",
  "rollback_to_legacy",
  "fail_closed"
]);
export type IdentityMigrationOutcome = z.infer<typeof identityMigrationOutcomeSchema>;

/** Required interruption/retry/repair/rollback matrix for one migration version. */
export const identityMigrationMatrixEntrySchema = z
  .object({
    legacyVersion: z.number().int().nonnegative(),
    migrationStep: identityMigrationStepSchema,
    authoritativeReadVersion: z.literal(workspaceIdentitySchemaVersion),
    interruptionMarker: identityMigrationMarkerSchema,
    retryResult: identityMigrationOutcomeSchema,
    repairResult: identityMigrationOutcomeSchema,
    rollbackResult: identityMigrationOutcomeSchema,
    readCutover: z.enum(["legacy", "workspace"]),
    partialFailureReadPolicy: z.literal("fail_closed")
  })
  .strict();
export type IdentityMigrationMatrixEntry = z.infer<typeof identityMigrationMatrixEntrySchema>;

export const identityMigrationMatrixSchema = z
  .object({
    schemaVersion: workspaceIdentityMigrationSchemaVersionSchema,
    migrationVersion: z.literal(1),
    readCutoverVersion: z.literal(workspaceIdentitySchemaVersion),
    entries: z.array(identityMigrationMatrixEntrySchema).min(1).max(32)
  })
  .strict();
export type IdentityMigrationMatrix = z.infer<typeof identityMigrationMatrixSchema>;
