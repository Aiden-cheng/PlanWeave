import type { OperatorCredential } from "../../operatorAuth.js";
import { OperatorSessionStore } from "../../identity/operatorSessionStore.js";
import { WorkspaceIdentityRepository } from "../../identity/workspaceRepository.js";
import { openServerDatabase } from "../../sqlite.js";

const fixtureIssuedAt = "2026-01-01T00:00:00.000Z";
const fixtureExpiresAt = "2030-01-01T00:00:00.000Z";

/** Seed durable operator sessions for tests that start a real Server composition. */
export async function seedOperatorSessions(
  databasePath: string,
  credentials: readonly OperatorCredential[]
): Promise<void> {
  const database = await openServerDatabase(databasePath, 5_000);
  try {
    const workspaceIdentity = new WorkspaceIdentityRepository(database);
    const store = new OperatorSessionStore(database);
    const fallbackWorkspace = database
      .prepare("SELECT workspace_id FROM workspaces ORDER BY workspace_id LIMIT 1")
      .get()?.workspace_id;
    if (typeof fallbackWorkspace !== "string") throw new Error("operator_fixture_workspace_missing");

    for (const credential of credentials) {
      const workspaceId =
        credential.projectIds
          .map((projectId) => workspaceIdentity.workspaceForLegacyProject(projectId))
          .find((value): value is string => value !== undefined) ?? fallbackWorkspace;
      const existing = database
        .prepare(
          "SELECT 1 FROM workspace_operator_sessions WHERE operator_id=? AND credential_sha256=?"
        )
        .get(credential.operatorId, credential.tokenSha256);
      if (existing) continue;
      store.create({
        workspaceId,
        operatorId: credential.operatorId,
        credentialSha256: credential.tokenSha256,
        issuedAt: fixtureIssuedAt,
        expiresAt: fixtureExpiresAt
      });
    }
  } finally {
    database.close();
  }
}
