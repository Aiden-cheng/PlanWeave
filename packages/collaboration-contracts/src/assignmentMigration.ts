import { z } from "zod";
import { assignmentTargetSchema, type AssignmentTarget } from "./assignment.js";
import { exactBlockExecutionScopeSchema, executionTargetSchema } from "./executionTarget.js";
import { collaborationWorkScopeSchema, responsibilityPrincipalSchema } from "./responsibility.js";
import { opaqueIdentifierSchema, workspaceIdSchema } from "./primitives.js";

export const assignmentMigrationSchemaVersion = "assignment-migration/v1" as const;
export const assignmentMigrationSchemaVersionSchema = z.literal(assignmentMigrationSchemaVersion);
export type AssignmentMigrationSchemaVersion = z.infer<
  typeof assignmentMigrationSchemaVersionSchema
>;

export const assignmentMigrationMarkerSchema = z.enum([
  "legacy_target_requires_explicit_mapping",
  "human_mapped_to_responsibility",
  "host_mapped_to_execution_target",
  "unassigned_mapped_to_no_target"
]);
export type AssignmentMigrationMarker = z.infer<typeof assignmentMigrationMarkerSchema>;

/** Legacy input is accepted only at this migration boundary. */
export const legacyAssignmentTargetSchema = assignmentTargetSchema;
export type LegacyAssignmentTarget = AssignmentTarget;

export const legacyAssignmentMigrationInputSchema = z
  .object({
    schemaVersion: assignmentMigrationSchemaVersionSchema,
    marker: z.literal("legacy_target_requires_explicit_mapping"),
    workspaceId: workspaceIdSchema,
    projectId: opaqueIdentifierSchema,
    workItem: collaborationWorkScopeSchema,
    target: legacyAssignmentTargetSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.workItem.workspaceId !== value.workspaceId) {
      context.addIssue({ code: "custom", message: "cross_workspace_legacy_assignment" });
    }
    if (value.workItem.projectId !== value.projectId) {
      context.addIssue({ code: "custom", message: "cross_project_legacy_assignment" });
    }
  });
export type LegacyAssignmentMigrationInput = z.infer<typeof legacyAssignmentMigrationInputSchema>;

const mappedBaseSchema = z.object({
  schemaVersion: assignmentMigrationSchemaVersionSchema,
  source: z.literal("legacy_assignment_target"),
  projectId: opaqueIdentifierSchema,
  scope: collaborationWorkScopeSchema
});

export const legacyResponsibilityMappingSchema = mappedBaseSchema
  .extend({
    mappedKind: z.literal("responsibility"),
    marker: z.literal("human_mapped_to_responsibility"),
    principal: responsibilityPrincipalSchema
  })
  .strict();
export type LegacyResponsibilityMapping = z.infer<typeof legacyResponsibilityMappingSchema>;

export const legacyExecutionTargetMappingSchema = mappedBaseSchema
  .extend({
    mappedKind: z.literal("execution_target"),
    marker: z.literal("host_mapped_to_execution_target"),
    scope: exactBlockExecutionScopeSchema,
    target: executionTargetSchema.refine((target) => target.kind !== "unassigned", {
      message: "legacy_unassigned_is_not_a_host_execution_target"
    })
  })
  .strict();
export type LegacyExecutionTargetMapping = z.infer<typeof legacyExecutionTargetMappingSchema>;

export const legacyUnassignedMappingSchema = mappedBaseSchema
  .extend({
    mappedKind: z.literal("unassigned"),
    marker: z.literal("unassigned_mapped_to_no_target")
  })
  .strict();
export type LegacyUnassignedMapping = z.infer<typeof legacyUnassignedMappingSchema>;

export const legacyAssignmentMappingSchema = z.discriminatedUnion("mappedKind", [
  legacyResponsibilityMappingSchema,
  legacyExecutionTargetMappingSchema,
  legacyUnassignedMappingSchema
]);
export type LegacyAssignmentMapping = z.infer<typeof legacyAssignmentMappingSchema>;

/** Explicitly maps legacy identities; unknown target kinds fail at parse time. */
export function mapLegacyAssignmentTarget(
  input: LegacyAssignmentMigrationInput
): LegacyAssignmentMapping {
  const parsed = legacyAssignmentMigrationInputSchema.parse(input);
  const base = {
    schemaVersion: assignmentMigrationSchemaVersion,
    source: "legacy_assignment_target" as const,
    projectId: parsed.projectId,
    scope: parsed.workItem
  };
  switch (parsed.target.kind) {
    case "human":
      return legacyAssignmentMappingSchema.parse({
        ...base,
        mappedKind: "responsibility",
        marker: "human_mapped_to_responsibility",
        principal: { kind: "human", humanPrincipalId: parsed.target.humanPrincipalId }
      });
    case "exact_host":
    case "automatic_host":
      if (parsed.workItem.kind !== "block") {
        throw new Error("legacy_host_target_requires_exact_block_scope");
      }
      return legacyAssignmentMappingSchema.parse({
        ...base,
        mappedKind: "execution_target",
        marker: "host_mapped_to_execution_target",
        scope: parsed.workItem,
        target:
          parsed.target.kind === "exact_host"
            ? { kind: "exact_host", hostId: parsed.target.hostId }
            : { kind: "automatic_host" }
      });
    case "unassigned":
      return legacyAssignmentMappingSchema.parse({
        ...base,
        mappedKind: "unassigned",
        marker: "unassigned_mapped_to_no_target"
      });
    default:
      return assertNeverLegacyTarget(parsed.target);
  }
}

function assertNeverLegacyTarget(value: never): never {
  throw new Error(`unknown_legacy_target_kind:${String(value)}`);
}
