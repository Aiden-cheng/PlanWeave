import { describe, expect, it } from "vitest";
import { applyMigrations } from "../migrations.js";
import { OperatorSessionStore } from "../identity/operatorSessionStore.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { hashOperatorToken, OperatorTokenRegistry } from "../operatorAuth.js";

const tokenA = `pw_operator_${"A".repeat(43)}`;
const tokenB = `pw_operator_${"B".repeat(43)}`;
const hostToken = `pw_host_${"C".repeat(43)}`;
const humanToken = `pw_hdev_${"D".repeat(43)}`;

async function openDatabase(): Promise<SqliteDatabase> {
  const database = await openServerDatabase(":memory:", 5_000);
  applyMigrations(database);
  return database;
}

function session(
  store: OperatorSessionStore,
  workspaceId: string,
  token = tokenA,
  expiresAt = "2030-01-02T00:00:00.000Z",
  operatorId = "operator-a"
) {
  return store.create({
    workspaceId,
    operatorId,
    credentialSha256: hashOperatorToken(token),
    issuedAt: "2030-01-01T00:00:00.000Z",
    expiresAt
  });
}

describe("OperatorTokenRegistry", () => {
  it("authenticates only strict operator credentials through durable sessions", async () => {
    const database = await openDatabase();
    try {
      const workspaceId = new WorkspaceIdentityRepository(database).ensureWorkspaceForLegacyProject(
        "project-a"
      );
      const store = new OperatorSessionStore(database, () => new Date("2030-01-01T12:00:00.000Z"));
      session(store, workspaceId);
      const registry = new OperatorTokenRegistry(database, [
        { operatorId: "operator-a", tokenSha256: hashOperatorToken(tokenA), projectIds: ["project-a"] }
      ], () => new Date("2030-01-01T12:00:00.000Z"));

      const principal = registry.authenticate(`Bearer ${tokenA}`);
      expect(principal).toMatchObject({ operatorId: "operator-a", workspaceId, projectIds: ["project-a"] });
      expect(registry.authenticate(`Bearer ${hostToken}`)).toBeUndefined();
      expect(registry.authenticate(`Bearer ${humanToken}`)).toBeUndefined();
      expect(registry.authenticate(`Bearer ${tokenB}`)).toBeUndefined();

      store.revoke(workspaceId, principal!.operatorSessionId, "2030-01-01T13:00:00.000Z");
      expect(registry.authenticate(`Bearer ${tokenA}`)).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("rejects expired and non-cutover sessions before authorization", async () => {
    const database = await openDatabase();
    try {
      const identity = new WorkspaceIdentityRepository(database);
      const workspaceId = identity.ensureWorkspaceForLegacyProject("project-a");
      const store = new OperatorSessionStore(database, () => new Date("2030-01-03T00:00:00.000Z"));
      expect(() => session(store, workspaceId)).not.toThrow();
      const registry = new OperatorTokenRegistry(database, [
        { operatorId: "operator-a", tokenSha256: hashOperatorToken(tokenA), projectIds: ["project-a"] }
      ], () => new Date("2030-01-03T00:00:00.000Z"));
      expect(registry.authenticate(`Bearer ${tokenA}`)).toBeUndefined();

      const pending = identity.ensureWorkspaceForLegacyProject("project-pending");
      database.prepare(
        "UPDATE workspace_identity_migrations SET status='in_progress', interruption_marker='workspace_created' WHERE workspace_id=?"
      ).run(pending);
      const pendingStore = new OperatorSessionStore(database);
      expect(() => session(pendingStore, pending, tokenB)).toThrow(
        "workspace_identity_read_cutover_incomplete"
      );
    } finally {
      database.close();
    }
  });

  it("requires an explicit matching workspace for scoped operators while admins may target another cutover workspace", async () => {
    const database = await openDatabase();
    try {
      const identity = new WorkspaceIdentityRepository(database);
      const firstWorkspace = identity.ensureWorkspaceForLegacyProject("project-a");
      const secondWorkspace = identity.ensureWorkspaceForLegacyProject("project-b");
      const store = new OperatorSessionStore(database);
      session(store, firstWorkspace);
      const registry = new OperatorTokenRegistry(database, [
        { operatorId: "operator-a", tokenSha256: hashOperatorToken(tokenA), projectIds: ["project-a"] }
      ]);
      const scoped = registry.authenticate(`Bearer ${tokenA}`)!;
      expect(() => registry.authorizeWorkspace(scoped, firstWorkspace, (projectId) =>
        identity.workspaceForLegacyProject(projectId)
      )).not.toThrow();
      expect(() => registry.authorizeWorkspace(scoped, secondWorkspace, (projectId) =>
        identity.workspaceForLegacyProject(projectId)
      )).toThrow("operator_workspace_forbidden");

      const adminToken = `pw_operator_${"E".repeat(43)}`;
      session(store, firstWorkspace, adminToken, "2030-01-02T00:00:00.000Z", "operator-admin");
      const adminRegistry = new OperatorTokenRegistry(database, [
        { operatorId: "operator-a", tokenSha256: hashOperatorToken(tokenA), projectIds: ["project-a"] },
        { operatorId: "operator-admin", tokenSha256: hashOperatorToken(adminToken), projectIds: [], serverAdmin: true }
      ]);
      const admin = adminRegistry.authenticate(`Bearer ${adminToken}`)!;
      expect(() => adminRegistry.authorizeWorkspace(admin, secondWorkspace, () => undefined)).not.toThrow();
      expect(identity.workspaceExists("workspace-does-not-exist")).toBe(false);
    } finally {
      database.close();
    }
  });

  it("rejects duplicate operator and token identities", async () => {
    const database = await openDatabase();
    try {
      expect(
        () =>
          new OperatorTokenRegistry(database, [
            { operatorId: "operator-a", tokenSha256: hashOperatorToken(tokenA), projectIds: [] },
            { operatorId: "operator-a", tokenSha256: hashOperatorToken(tokenB), projectIds: [] }
          ])
      ).toThrowError("operator_id_duplicate");
      expect(
        () =>
          new OperatorTokenRegistry(database, [
            { operatorId: "operator-a", tokenSha256: hashOperatorToken(tokenA), projectIds: [] },
            { operatorId: "operator-b", tokenSha256: hashOperatorToken(tokenA), projectIds: [] }
          ])
      ).toThrowError("operator_token_duplicate");
    } finally {
      database.close();
    }
  });
});
