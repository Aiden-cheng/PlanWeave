import { createHash } from "node:crypto";
import {
  credentialSha256Schema,
  operatorSessionIdSchema,
  type OperatorSession
} from "@planweave-ai/collaboration-contracts";
import { opaqueIdentifierSchema } from "@planweave-ai/distributed-protocol";
import { z } from "zod";
import { operatorCredentialSchema, type OperatorCredential } from "../operatorAuth.js";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import { OperatorSessionStore } from "./operatorSessionStore.js";

export type OperatorSessionProvisioningInput = {
  database: SqliteDatabase;
  credentials: readonly OperatorCredential[];
  trustedProjectIds: readonly string[];
  workspaceForProject: (projectId: string) => string | undefined;
  /** Explicit anchor for server-admin sessions when legacy project IDs are ambiguous. */
  serverAdminAnchorWorkspaceId?: string;
  operatorSessionTtlMs: number;
  clock?: () => Date;
};

type ProvisioningPlan = {
  credential: OperatorCredential;
  workspaceId: string;
  operatorSessionId: string;
};

const operatorSessionTtlSchema = z
  .number()
  .int()
  .min(60 * 60 * 1_000)
  .max(365 * 24 * 60 * 60 * 1_000);

function stableOperatorSessionId(workspaceId: string, credential: OperatorCredential): string {
  const digest = createHash("sha256")
    .update(`${workspaceId}:${credential.operatorId}:${credential.tokenSha256}`)
    .digest("hex")
    .slice(0, 32);
  return operatorSessionIdSchema.parse(`operator-session-${digest}`);
}

function resolveCredentialWorkspace(
  credential: OperatorCredential,
  trustedProjectIds: ReadonlySet<string>,
  workspaceForProject: (projectId: string) => string | undefined,
  anchorWorkspaceId: string
): string {
  if (credential.serverAdmin) {
    if (credential.projectIds.length > 0) throw new Error("operator_server_admin_scope_invalid");
    return anchorWorkspaceId;
  }
  if (credential.projectIds.length === 0) throw new Error("operator_project_scope_required");
  const workspaceIds = new Set<string>();
  for (const projectId of credential.projectIds) {
    if (!trustedProjectIds.has(projectId)) throw new Error("operator_project_not_trusted");
    const workspaceId = workspaceForProject(projectId);
    if (!workspaceId) throw new Error("operator_project_workspace_mapping_missing");
    workspaceIds.add(opaqueIdentifierSchema.parse(workspaceId));
  }
  if (workspaceIds.size !== 1) throw new Error("operator_scope_workspace_ambiguous");
  return [...workspaceIds][0];
}

function existingSessionMatches(session: OperatorSession, plan: ProvisioningPlan): boolean {
  return (
    session.workspaceId === plan.workspaceId && session.operatorId === plan.credential.operatorId
  );
}

/** Provision configured operator digests into durable workspace sessions without secrets. */
export function provisionConfiguredOperatorSessions(
  input: OperatorSessionProvisioningInput
): OperatorSession[] {
  const credentials = z.array(operatorCredentialSchema).min(1).max(1_024).parse(input.credentials);
  const trustedProjectIds = new Set(
    input.trustedProjectIds.map((projectId) => opaqueIdentifierSchema.parse(projectId))
  );
  if (trustedProjectIds.size === 0) throw new Error("operator_anchor_workspace_missing");
  const anchorWorkspaceId =
    input.serverAdminAnchorWorkspaceId ?? input.workspaceForProject([...trustedProjectIds][0]);
  if (!anchorWorkspaceId) throw new Error("operator_anchor_workspace_missing");
  const ttlMs = operatorSessionTtlSchema.parse(input.operatorSessionTtlMs);
  const clock = input.clock ?? (() => new Date());
  const plans = credentials.map((credential) => ({
    credential,
    workspaceId: resolveCredentialWorkspace(
      credential,
      trustedProjectIds,
      input.workspaceForProject,
      anchorWorkspaceId
    ),
    operatorSessionId: ""
  }));
  for (const plan of plans) {
    plan.operatorSessionId = stableOperatorSessionId(plan.workspaceId, plan.credential);
  }

  const sessions = new OperatorSessionStore(input.database, clock);
  return inWriteTransaction(input.database, () => {
    const issuedAt = clock().toISOString();
    const expiresAt = new Date(new Date(issuedAt).getTime() + ttlMs).toISOString();
    return plans.map((plan) => {
      const existingByDigest = sessions.findByCredentialDigest(plan.credential.tokenSha256);
      if (existingByDigest) {
        if (!existingSessionMatches(existingByDigest, plan)) {
          throw new Error("operator_session_credential_conflict");
        }
        return existingByDigest;
      }
      const existingById = sessions.findBySessionId(plan.workspaceId, plan.operatorSessionId);
      if (existingById) {
        if (!existingSessionMatches(existingById, plan)) {
          throw new Error("operator_session_identity_conflict");
        }
        if (
          existingById.credentialSha256 !==
          credentialSha256Schema.parse(plan.credential.tokenSha256)
        ) {
          throw new Error("operator_session_identity_conflict");
        }
        return existingById;
      }
      return sessions.create({
        workspaceId: plan.workspaceId,
        operatorSessionId: plan.operatorSessionId,
        operatorId: plan.credential.operatorId,
        credentialSha256: credentialSha256Schema.parse(plan.credential.tokenSha256),
        issuedAt,
        expiresAt
      });
    });
  });
}
