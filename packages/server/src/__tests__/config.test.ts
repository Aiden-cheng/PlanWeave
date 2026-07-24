import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashOperatorToken } from "../operatorAuth.js";
import {
  parseServerConfig,
  resolveServerConfigPath,
  serverConfigSchema,
  serverConfigSummary
} from "../config.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function secureConfig() {
  const root = await mkdtemp(join(tmpdir(), "planweave-server-config-"));
  directories.push(root);
  return {
    version: "server-config/v1" as const,
    bind: { host: "127.0.0.1", port: 7_443 },
    publicUrl: "https://127.0.0.1:7443",
    tls: {
      certificatePath: join(root, "server.crt"),
      privateKeyPath: join(root, "server.key")
    },
    dataDirectory: join(root, "data"),
    trustedProjects: [{ projectId: "project-1", canvasId: "default", projectRoot: root }],
    operatorCredentials: [
      {
        operatorId: "admin",
        tokenSha256: hashOperatorToken("config_admin_token_abcdefghijklmnopqrstuvwxyz"),
        projectIds: [],
        serverAdmin: true
      }
    ]
  };
}

describe("server config", () => {
  it("normalizes secure config and exposes only a safe summary", async () => {
    const input = await secureConfig();
    const config = parseServerConfig(input);

    expect(config.databasePath).toBe(join(input.dataDirectory, "planweave-server.sqlite"));
    expect(serverConfigSummary(config)).toEqual({
      version: "server-config/v1",
      bindHost: "127.0.0.1",
      bindPort: 7_443,
      publicUrl: "https://127.0.0.1:7443",
      transport: "https",
      projectIds: ["project-1"]
    });
    expect(JSON.stringify(serverConfigSummary(config))).not.toContain(input.dataDirectory);
    expect(JSON.stringify(serverConfigSummary(config))).not.toContain("token");
  });

  it("requires matching TLS public and bind ports", async () => {
    const input = await secureConfig();
    expect(() => parseServerConfig({ ...input, publicUrl: "https://127.0.0.1:8443" })).toThrow(
      "server_public_url_port_mismatch"
    );
  });

  it("requires heartbeat to precede offline and lease thresholds", async () => {
    const input = await secureConfig();
    expect(() =>
      parseServerConfig({
        ...input,
        limits: { heartbeatIntervalMs: 30_000, leaseDurationMs: 30_000 }
      })
    ).toThrow("server_heartbeat_must_precede_lease");
    expect(() =>
      parseServerConfig({
        ...input,
        limits: { heartbeatIntervalMs: 90_000, hostOfflineAfterMs: 90_000 }
      })
    ).toThrow("server_heartbeat_must_precede_offline");
  });

  it("allows insecure transport only on literal loopback", async () => {
    const input = await secureConfig();
    const insecure = {
      ...input,
      publicUrl: "http://127.0.0.1:7443",
      tls: undefined,
      allowInsecureDevelopment: true
    };
    expect(parseServerConfig(insecure).allowInsecureDevelopment).toBe(true);
    expect(() => parseServerConfig({ ...insecure, publicUrl: "http://localhost:7443" })).toThrow(
      "server_insecure_development_requires_literal_loopback"
    );
    expect(() => parseServerConfig({ ...input, tls: undefined })).toThrow(
      "server_tls_configuration_required"
    );
  });

  it("rejects duplicate roots, duplicate locators, and crafted database paths", async () => {
    const input = await secureConfig();
    const duplicateRoot = {
      ...input,
      trustedProjects: [
        ...input.trustedProjects,
        {
          projectId: "project-2",
          canvasId: "default",
          projectRoot: input.trustedProjects[0].projectRoot
        }
      ]
    };
    expect(() => parseServerConfig(duplicateRoot)).toThrow("server_trusted_project_duplicate");

    const parsed = parseServerConfig(input);
    expect(() =>
      serverConfigSchema.parse({
        ...parsed,
        databasePath: join(input.dataDirectory, "other.sqlite")
      })
    ).toThrow("server_database_path_mismatch");
  });

  it("prefers an explicit CLI config path over the environment", async () => {
    const root = (await secureConfig()).dataDirectory;
    const cli = join(root, "cli.json");
    const environment = join(root, "environment.json");
    expect(
      resolveServerConfigPath(["--config", cli], { PLANWEAVE_SERVER_CONFIG: environment })
    ).toBe(cli);
    expect(resolveServerConfigPath([], { PLANWEAVE_SERVER_CONFIG: environment })).toBe(environment);
  });
});
