import {
  executionTargetSchema,
  executionTargetRecordSchema,
  exactBlockExecutionScopeSchema,
  executionTargetUpdateWireCommandSchema,
  type ExecutionTarget,
  type ExecutionTargetRecord
} from "@planweave-ai/collaboration-protocol/work/execution-target";
import {
  reviewAssignmentRecordSchema,
  reviewAssignmentUpdateWireCommandSchema,
  type ReviewAssignmentRecord
} from "@planweave-ai/collaboration-protocol/work/review";
import {
  responsibilityRecordSchema,
  collaborationWorkScopeSchema,
  responsibilityUpdateWireCommandSchema,
  type CollaborationWorkScope,
  type ResponsibilityRecord
} from "@planweave-ai/collaboration-protocol/work/responsibility";
import { blockRefSchema, opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import { z } from "zod";

export const authorityScopeSchema = collaborationWorkScopeSchema;
export type AuthorityScope = CollaborationWorkScope;
export const exactBlockScopeSchema = exactBlockExecutionScopeSchema;

export const authorityRevisionSnapshotSchema = z
  .object({
    responsibilityRevision: z.number().int().nonnegative(),
    reviewerRevision: z.number().int().nonnegative(),
    executionTargetRevision: z.number().int().nonnegative()
  })
  .strict();
export type AuthorityRevisionSnapshot = z.infer<typeof authorityRevisionSnapshotSchema>;

export const authorityActorSchema = z
  .object({ kind: z.enum(["human", "local_admin", "system"]), id: opaqueIdentifierSchema })
  .strict();
export type AuthorityActor = z.infer<typeof authorityActorSchema>;

export const responsibilityMutationSchema = responsibilityUpdateWireCommandSchema;
export const reviewerMutationSchema = reviewAssignmentUpdateWireCommandSchema;
export const executionTargetMutationSchema = executionTargetUpdateWireCommandSchema;

export type ResponsibilityMutation = z.infer<typeof responsibilityMutationSchema>;
export type ReviewerMutation = z.infer<typeof reviewerMutationSchema>;
export type ExecutionTargetMutation = z.infer<typeof executionTargetMutationSchema>;

export const authorityRecordSchema = z.discriminatedUnion("authority", [
  z.object({ authority: z.literal("responsibility"), record: responsibilityRecordSchema }).strict(),
  z.object({ authority: z.literal("reviewer"), record: reviewAssignmentRecordSchema }).strict(),
  z
    .object({ authority: z.literal("execution_target"), record: executionTargetRecordSchema })
    .strict()
]);

export const authorityTargetSchema = executionTargetSchema;
export type AuthorityTarget = ExecutionTarget;
export type AuthorityRecord =
  | { authority: "responsibility"; record: ResponsibilityRecord }
  | { authority: "reviewer"; record: ReviewAssignmentRecord }
  | { authority: "execution_target"; record: ExecutionTargetRecord };

export function scopeKey(scope: AuthorityScope): string {
  if (scope.kind === "task") return scope.taskId;
  return blockRefSchema.parse(scope.blockRef);
}

export function assertScopeProject(scope: AuthorityScope, projectId: string): void {
  if (scope.projectId !== projectId) throw new Error("authority_project_scope_mismatch");
}

export function assertExactBlock(
  scope: AuthorityScope
): asserts scope is Extract<AuthorityScope, { kind: "block" }> {
  if (scope.kind !== "block") throw new Error("execution_target_requires_exact_block_scope");
}
