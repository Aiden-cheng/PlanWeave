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
    publicUrl: "https://server.example.test:7443",
    deployment: {
      topology: "lan_https",
      serverOrigin: "https://server.example.test:7443",
      allowedClientOrigins: ["https://desktop.example.test/"],
      tlsTrust: "configured_ca"
    },
    tls: {
      certificatePath: join(root, "server.crt"),
      privateKeyPath: join(root, "server.key")
    },
    dataDirectory: join(root, "data"),
    trustedProjects: [
      {
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "default",
        projectRoot: root
      }
    ],
    operatorCredentials: [
      {
        operatorId: "admin",
        tokenSha256: hashOperatorToken(`pw_operator_${"C".repeat(43)}`),
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
    expect(config.operatorSessionTtlMs).toBe(30 * 24 * 60 * 60 * 1_000);
    expect(serverConfigSummary(config)).toEqual({
      version: "server-config/v1",
      bindHost: "127.0.0.1",
      bindPort: 7_443,
      publicUrl: "https://server.example.test:7443",
      transport: "https",
      deployment: {
        topology: "lan_https",
        allowedClientOrigins: ["https://desktop.example.test/"]
      },
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

  it("accepts trusted TLS on a literal loopback endpoint", async () => {
    const input = await secureConfig();
    const loopback = parseServerConfig({
      ...input,
      publicUrl: "https://127.0.0.1:7443",
      deployment: {
        topology: "loopback_https",
        serverOrigin: "https://127.0.0.1:7443",
        allowedClientOrigins: ["https://127.0.0.1:7443"],
        tlsTrust: "configured_ca"
      }
    });
    expect(loopback.deployment?.topology).toBe("loopback_https");
    expect(serverConfigSummary(loopback).deployment?.topology).toBe("loopback_https");
  });

  it("requires a bounded matching deployment endpoint for network listeners", async () => {
    const input = await secureConfig();
    expect(() => parseServerConfig({ ...input, deployment: undefined })).toThrow(
      "server_deployment_configuration_required"
    );
    expect(() =>
      parseServerConfig({
        ...input,
        deployment: { ...input.deployment, serverOrigin: "https://other.example.test:7443" }
      })
    ).toThrow("server_deployment_endpoint_mismatch");
    expect(() =>
      parseServerConfig({
        ...input,
        deployment: {
          ...input.deployment,
          topology: "public_https",
          serverOrigin: "https://server.example.test:7443"
        }
      })
    ).toThrow("public_https_requires_direct_tls_port_443");
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

  it("bounds the configured operator session lifetime", async () => {
    const input = await secureConfig();
    expect(() =>
      parseServerConfig({ ...input, operatorSessionTtlMs: 60 * 60 * 1_000 - 1 })
    ).toThrow();
    expect(() =>
      parseServerConfig({ ...input, operatorSessionTtlMs: 365 * 24 * 60 * 60 * 1_000 + 1 })
    ).toThrow();
  });

  it("allows insecure transport only on literal loopback", async () => {
    const input = await secureConfig();
    const insecure = {
      ...input,
      publicUrl: "http://127.0.0.1:7443",
      tls: undefined,
      deployment: undefined,
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

  it("allows explicit HTTP only on a private LAN listener", async () => {
    const input = await secureConfig();
    const lan = parseServerConfig({
      ...input,
      bind: { host: "0.0.0.0", port: 7_443 },
      publicUrl: "http://192.168.1.20:7443",
      tls: undefined,
      deployment: undefined,
      allowInsecureDevelopment: true,
      allowInsecureLan: true
    });
    expect(serverConfigSummary(lan).transport).toBe("lan-http");
    const { databasePath: _databasePath, ...lanInput } = lan;
    expect(() =>
      parseServerConfig({ ...lanInput, publicUrl: "http://203.0.113.10:7443" })
    ).toThrow("server_insecure_lan_requires_private_http");
    expect(() =>
      parseServerConfig({ ...lanInput, bind: { host: "127.0.0.1", port: 7_443 } })
    ).toThrow("server_insecure_lan_requires_private_http");
  });

  it("rejects duplicate exact scopes and accepts same IDs in separate Workspaces", async () => {
    const input = await secureConfig();
    const duplicateRoot = {
      ...input,
      trustedProjects: [
        ...input.trustedProjects,
        {
          projectId: "project-2",
          workspaceId: "workspace-2",
          canvasId: "default",
          projectRoot: input.trustedProjects[0].projectRoot
        }
      ]
    };
    expect(parseServerConfig(duplicateRoot).trustedProjects).toHaveLength(2);

    const duplicateScope = {
      ...input,
      trustedProjects: [
        ...input.trustedProjects,
        {
          projectId: "project-1",
          workspaceId: "workspace-1",
          canvasId: "default",
          projectRoot: join(input.dataDirectory, "other-project")
        }
      ]
    };
    expect(() => parseServerConfig(duplicateScope)).toThrow("server_trusted_project_duplicate");

    const sameProjectInOtherWorkspace = {
      ...input,
      trustedProjects: [
        ...input.trustedProjects,
        {
          workspaceId: "workspace-2",
          projectId: "project-1",
          canvasId: "default",
          projectRoot: join(input.dataDirectory, "other-project")
        }
      ]
    };
    expect(parseServerConfig(sameProjectInOtherWorkspace).trustedProjects).toHaveLength(2);

    const separateCanvases = {
      ...input,
      trustedProjects: [
        ...input.trustedProjects,
        {
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: "planning",
          projectRoot: input.trustedProjects[0].projectRoot
        }
      ]
    };
    expect(parseServerConfig(separateCanvases).trustedProjects).toHaveLength(2);

    expect(
      parseServerConfig({ ...input, trustedProjects: [{ ...input.trustedProjects[0] }] })
    ).toMatchObject({
      trustedProjects: [{ workspaceId: "workspace-1", projectId: "project-1", canvasId: "default" }]
    });
    const allDeclared = parseServerConfig({
      ...input,
      trustedProjects: [
        {
          workspaceId: "workspace-1",
          projectId: "project-1",
          projectRoot: input.trustedProjects[0].projectRoot,
          trustAllDeclaredCanvases: true
        }
      ]
    });
    expect(allDeclared.trustedProjects[0]).toMatchObject({
      projectId: "project-1",
      trustAllDeclaredCanvases: true
    });
    expect(allDeclared.trustedProjects[0].canvasId).toBeUndefined();
    expect(() =>
      parseServerConfig({
        ...input,
        trustedProjects: [
          {
            workspaceId: "workspace-1",
            projectId: "project-1",
            projectRoot: input.trustedProjects[0].projectRoot
          }
        ]
      })
    ).toThrow("trusted_project_canvas_required");
    expect(() =>
      parseServerConfig({
        ...input,
        trustedProjects: [
          {
            workspaceId: "workspace-1",
            projectId: "project-1",
            canvasId: "default",
            projectRoot: input.trustedProjects[0].projectRoot,
            trustAllDeclaredCanvases: true
          }
        ]
      })
    ).toThrow("trusted_project_canvas_scope_conflict");

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
