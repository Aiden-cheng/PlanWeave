import { afterEach, describe, expect, it } from "vitest";
import {
  canvasScopeRefSchema,
  type ActorRef,
  type CanvasScopeRef
} from "@planweave-ai/collaboration-protocol/core/primitives";
import { loopbackServerProfileSchema } from "@planweave-ai/collaboration-protocol/loopback";
import { serverReadinessSchema } from "../readiness.js";
import { parseServerConfig, type ServerConfig } from "../config.js";
import type { DistributedServerProcess } from "../serverServe.js";
import { LoopbackServerController } from "../loopbackController.js";
import { applyMigrations } from "../migrations.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import type { TrustedProjectControlPort } from "../trustedProjectControl.js";

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const profile = loopbackServerProfileSchema.parse({
  profileId: "local",
  displayName: "Local Server",
  serverBaseUrl: "http://127.0.0.1:7443",
  allowInsecureTransport: true
});

function config(overrides: { publicUrl?: string } = {}): ServerConfig {
  return parseServerConfig({
    version: "server-config/v1",
    bind: { host: "127.0.0.1", port: 7443 },
    publicUrl: "http://127.0.0.1:7443",
    allowInsecureDevelopment: true,
    dataDirectory: "/tmp/planweave-loopback-test",
    trustedProjects: [{ workspaceId: "w", projectId: "p", canvasId: "c", projectRoot: "/tmp/project" }],
    operatorCredentials: [{ operatorId: "operator", tokenSha256: "a".repeat(64), projectIds: ["p"] }],
    limits: {
      busyTimeoutMs: 5_000,
      leaseDurationMs: 30_000,
      hostOfflineAfterMs: 90_000,
      heartbeatIntervalMs: 15_000,
      maxArtifactBytes: 1_024,
      maxWebSocketPayloadBytes: 1_024,
      eventRetentionMaxEvents: 100,
      eventRetentionMaxBytes: 1_024,
      shutdownTimeoutMs: 100
    },
    ...overrides
  });
}

const unavailableTrustedProjectControl: TrustedProjectControlPort = {
  listTrustedProjectScopes: () => [],
  resolveTrustedProjectScope: () => undefined,
  assertTrustedProjectAdministration: () => {
    throw new Error("loopback_trusted_project_scope_not_found");
  }
};

function process(
  close: () => Promise<void>,
  trustedProjectControl: TrustedProjectControlPort = unavailableTrustedProjectControl
): DistributedServerProcess {
  return {
    version: "test",
    publicUrl: profile.serverBaseUrl,
    trustedProjectControl,
    readiness: () =>
      serverReadinessSchema.parse({
        status: "ready",
        schemaVersion: 1,
        startedAt: "2026-01-02T00:00:00.000Z",
        detail: null
      }),
    close
  };
}

function scopeKey(scope: CanvasScopeRef): string {
  return `${scope.workspaceId}\0${scope.projectId}\0${scope.canvasId}`;
}

function runningTrustedProjectControl(
  access: ProjectAccessRepository,
  scopes: readonly CanvasScopeRef[]
): TrustedProjectControlPort {
  const configured = new Map(scopes.map((scope) => [scopeKey(scope), scope]));
  const resolveTrustedProjectScope = (rawScope: unknown) => {
    const scope = canvasScopeRefSchema.parse(rawScope);
    return configured.get(scopeKey(scope));
  };
  return {
    listTrustedProjectScopes: () => [...configured.values()],
    resolveTrustedProjectScope,
    assertTrustedProjectAdministration(actor: ActorRef, rawScope: unknown) {
      const scope = resolveTrustedProjectScope(rawScope);
      if (!scope) throw new Error("loopback_trusted_project_scope_not_found");
      access.policy.assertCapability({ ...scope, actor, capability: "administration" });
      return scope;
    }
  };
}

async function accessFixture() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  database.exec(`
    INSERT INTO workspaces(workspace_id,display_name,created_at) VALUES
      ('w','Workspace','2026-01-01T00:00:00.000Z'),
      ('w-other','Other workspace','2026-01-01T00:00:00.000Z');
    INSERT INTO workspace_principals(workspace_id,human_principal_id,display_name,created_at,revoked_at) VALUES
      ('w','owner','Owner','2026-01-01T00:00:00.000Z',NULL),
      ('w','editor','Editor','2026-01-01T00:00:00.000Z',NULL),
      ('w','viewer','Viewer','2026-01-01T00:00:00.000Z',NULL),
      ('w-other','other-owner','Other owner','2026-01-01T00:00:00.000Z',NULL);
    INSERT INTO workspace_memberships(workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at) VALUES
      ('w','m-owner','owner','owner',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL),
      ('w','m-editor','editor','member',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL),
      ('w','m-viewer','viewer','member',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL),
      ('w-other','m-other-owner','other-owner','owner',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL);
  `);
  const access = new ProjectAccessRepository(database, () => new Date("2026-01-02T00:00:00.000Z"));
  access.registerProjectInternal({ workspaceId: "w", projectId: "p", projectRoot: "/tmp/project", ownerHumanPrincipalId: "owner" });
  access.registerCanvasInternal({ workspaceId: "w", projectId: "p", canvasId: "c", packageDir: "/tmp/project/c", ownerHumanPrincipalId: "owner" });
  access.registerProjectInternal({ workspaceId: "w-other", projectId: "p", projectRoot: "/tmp/other-project", ownerHumanPrincipalId: "other-owner" });
  access.registerCanvasInternal({ workspaceId: "w-other", projectId: "p", canvasId: "c", packageDir: "/tmp/other-project/c", ownerHumanPrincipalId: "other-owner" });
  return access;
}

describe("loopback controller", () => {
  it("starts once, exposes readiness, and stops the owned process", async () => {
    let starts = 0;
    let closes = 0;
    const controller = new LoopbackServerController({
      createConfig: () => config(),
      serve: async () => {
        starts += 1;
        return process(async () => {
          closes += 1;
        });
      },
      clock: () => new Date("2026-01-02T00:00:00.000Z")
    });
    await expect(controller.apply({ action: "start", profile })).resolves.toMatchObject({ state: "running", profile });
    await expect(controller.apply({ action: "start", profile })).resolves.toMatchObject({ state: "running" });
    expect(starts).toBe(1);
    await expect(controller.apply({ action: "stop", profileId: profile.profileId })).resolves.toMatchObject({ state: "stopped", profile: null });
    expect(closes).toBe(1);
  });

  it("fails closed for profile/config mismatch and surfaces retryable start and stop failures", async () => {
    const wrongConfig = new LoopbackServerController({ createConfig: () => config({ publicUrl: "http://127.0.0.1:7444" }) });
    await expect(wrongConfig.apply({ action: "start", profile })).resolves.toMatchObject({ state: "error", reason: "start_failed" });
    expect(loopbackServerProfileSchema.safeParse({ ...profile, serverBaseUrl: "https://example.test:7443" }).success).toBe(false);

    let starts = 0;
    let closes = 0;
    const controller = new LoopbackServerController({
      createConfig: () => config(),
      serve: async () => {
        starts += 1;
        if (starts === 1) throw new Error("start failed");
        return process(async () => {
          closes += 1;
          if (closes === 1) throw new Error("stop failed");
        });
      }
    });
    await expect(controller.apply({ action: "start", profile })).resolves.toMatchObject({ state: "error", reason: "start_failed" });
    await expect(controller.apply({ action: "start", profile })).resolves.toMatchObject({ state: "running" });
    await expect(controller.apply({ action: "start", profile: { ...profile, profileId: "other" } })).rejects.toThrow("loopback_profile_already_running");
    await expect(controller.apply({ action: "stop", profileId: profile.profileId })).resolves.toMatchObject({ state: "error", reason: "stop_failed" });
    await expect(controller.apply({ action: "stop", profileId: profile.profileId })).resolves.toMatchObject({ state: "stopped" });
  });

  it("resolves and registers only exact running trusted scopes through real administration policy", async () => {
    const access = await accessFixture();
    const trustedProjectControl = runningTrustedProjectControl(access, [
      canvasScopeRefSchema.parse({ workspaceId: "w", projectId: "p", canvasId: "c" }),
      canvasScopeRefSchema.parse({ workspaceId: "w-other", projectId: "p", canvasId: "c" })
    ]);
    const controller = new LoopbackServerController({
      createConfig: () => config(),
      serve: async () => process(async () => {}, trustedProjectControl),
      clock: () => new Date("2026-01-02T00:00:00.000Z")
    });
    const request = { workspaceId: "w", projectId: "p", canvasId: "c", profileId: "local" };
    expect(() => controller.listTrustedProjectScopes({ profileId: profile.profileId })).toThrow(
      "loopback_server_not_running"
    );
    await controller.apply({ action: "start", profile });
    expect(controller.listTrustedProjectScopes({ profileId: profile.profileId })).toEqual([
      { workspaceId: "w", projectId: "p", canvasId: "c" },
      { workspaceId: "w-other", projectId: "p", canvasId: "c" }
    ]);
    expect(controller.resolveTrustedProjectScope(request)).toEqual({
      workspaceId: "w",
      projectId: "p",
      canvasId: "c"
    });
    const registered = controller.registerTrustedProject({ kind: "human", id: "owner" }, request);
    expect(registered).toMatchObject({ ...request, registeredAt: "2026-01-02T00:00:00.000Z" });
    expect(JSON.stringify(registered)).not.toMatch(/path|secret|token|tmp/);
    expect(() => controller.registerTrustedProject({ kind: "human", id: "editor" }, request)).toThrow("access_capability_denied");
    expect(() => controller.registerTrustedProject({ kind: "human", id: "viewer" }, request)).toThrow("access_capability_denied");
    expect(() => controller.registerTrustedProject({ kind: "human", id: "owner" }, { ...request, workspaceId: "w-other" })).toThrow("access_capability_denied");
    expect(() => controller.resolveTrustedProjectScope({ ...request, canvasId: "other" })).toThrow("loopback_registration_not_trusted");
    expect(() => controller.registerTrustedProject({ kind: "human", id: "owner" }, { ...request, profileId: "unknown" })).toThrow("loopback_profile_mismatch");
    await controller.apply({ action: "stop", profileId: profile.profileId });
    expect(() => controller.registerTrustedProject({ kind: "human", id: "owner" }, request)).toThrow("loopback_server_not_running");
  });
});
