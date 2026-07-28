import { afterEach, describe, expect, it } from "vitest";
import {
  loopbackServerProfileSchema
} from "@planweave-ai/collaboration-contracts";
import { serverReadinessSchema } from "../readiness.js";
import { serverConfigSchema, type ServerConfig } from "../config.js";
import type { DistributedServerProcess } from "../serverServe.js";
import {
  FixedProjectRegistrationController,
  LoopbackServerController
} from "../loopbackController.js";
import { applyMigrations } from "../migrations.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

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

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return serverConfigSchema.parse({
    version: "server-config/v1",
    bind: { host: "127.0.0.1", port: 7443 },
    publicUrl: "http://127.0.0.1:7443",
    allowInsecureDevelopment: true,
    dataDirectory: "/tmp/planweave-loopback-test",
    databasePath: "/tmp/planweave-loopback-test/planweave-server.sqlite",
    trustedProjects: [{ projectId: "p", canvasId: "c", projectRoot: "/tmp/project" }],
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

function process(close: () => Promise<void>): DistributedServerProcess {
  return {
    version: "test",
    publicUrl: profile.serverBaseUrl,
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

async function accessFixture() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  database.exec(`
    INSERT INTO workspaces(workspace_id,display_name,created_at) VALUES ('w','Workspace','2026-01-01T00:00:00.000Z');
    INSERT INTO workspace_principals(workspace_id,human_principal_id,display_name,created_at,revoked_at) VALUES
      ('w','owner','Owner','2026-01-01T00:00:00.000Z',NULL),
      ('w','editor','Editor','2026-01-01T00:00:00.000Z',NULL),
      ('w','viewer','Viewer','2026-01-01T00:00:00.000Z',NULL);
    INSERT INTO workspace_memberships(workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at) VALUES
      ('w','m-owner','owner','owner',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL),
      ('w','m-editor','editor','member',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL),
      ('w','m-viewer','viewer','member',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL);
  `);
  const access = new ProjectAccessRepository(database, () => new Date("2026-01-02T00:00:00.000Z"));
  access.registerProjectInternal({ workspaceId: "w", projectId: "p", projectRoot: "/tmp/project", ownerHumanPrincipalId: "owner" });
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

  it("registers only configured owner scope without paths or secrets", async () => {
    const access = await accessFixture();
    const controller = new FixedProjectRegistrationController(
      [
        { workspaceId: "w", projectId: "p", profileId: "local" },
        { workspaceId: "other", projectId: "p", profileId: "local" }
      ],
      access,
      () => new Date("2026-01-02T00:00:00.000Z")
    );
    const request = { workspaceId: "w", projectId: "p", profileId: "local" };
    const first = controller.register({ kind: "human", id: "owner" }, request);
    expect(controller.register({ kind: "human", id: "owner" }, request)).toEqual(first);
    expect(JSON.stringify(first)).not.toMatch(/path|secret|token|tmp/);
    expect(() => controller.register({ kind: "human", id: "editor" }, request)).toThrow("access_capability_denied");
    expect(() => controller.register({ kind: "human", id: "viewer" }, request)).toThrow("access_capability_denied");
    expect(() => controller.register({ kind: "human", id: "owner" }, { ...request, workspaceId: "other" })).toThrow();
    expect(() => controller.register({ kind: "human", id: "owner" }, { ...request, profileId: "unknown" })).toThrow("loopback_registration_not_configured");
  });
});
