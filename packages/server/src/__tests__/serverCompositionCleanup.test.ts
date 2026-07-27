import { createServer } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { PlanPackageManifest } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";

const cleanupSpies = vi.hoisted(() => ({
  webSocketClose: vi.fn(async () => {
    throw new Error("websocket_close_failed");
  }),
  retentionStart: vi.fn(async () => {}),
  retentionClose: vi.fn(async () => {}),
  runtimeRegistryClose: vi.fn()
}));

vi.mock("../comments/index.js", async () => {
  const actual =
    await vi.importActual<typeof import("../comments/index.js")>("../comments/index.js");
  return {
    ...actual,
    ActivityRetentionMaintenance: class {
      start = cleanupSpies.retentionStart;
      close = cleanupSpies.retentionClose;
    }
  };
});

vi.mock("../wsServer.js", async () => {
  const actual = await vi.importActual<typeof import("../wsServer.js")>("../wsServer.js");
  return {
    ...actual,
    attachAgentHostWebSocketServer: () => ({
      disconnectHost: () => {},
      close: cleanupSpies.webSocketClose
    })
  };
});

vi.mock("../runtimeProjectRegistry.js", async () => {
  const actual = await vi.importActual<typeof import("../runtimeProjectRegistry.js")>(
    "../runtimeProjectRegistry.js"
  );
  return {
    ...actual,
    createTrustedRuntimeRegistry: async (
      projects: Parameters<typeof actual.createTrustedRuntimeRegistry>[0]
    ) => {
      const registry = await actual.createTrustedRuntimeRegistry(projects);
      return {
        ...registry,
        close() {
          cleanupSpies.runtimeRegistryClose();
          registry.close();
        }
      };
    }
  };
});

import { hashOperatorToken } from "../operatorAuth.js";
import { parseServerConfig } from "../config.js";
import { createDistributedServerComposition } from "../serverComposition.js";
import { seedOperatorSessions } from "./support/operatorAuthFixture.js";

const directories: string[] = [];

afterEach(async () => {
  cleanupSpies.webSocketClose.mockClear();
  cleanupSpies.retentionStart.mockClear();
  cleanupSpies.retentionClose.mockClear();
  cleanupSpies.runtimeRegistryClose.mockClear();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function remoteManifest(): PlanPackageManifest {
  const manifest = basicManifest();
  manifest.execution.defaultExecutor = "codex-acp";
  manifest.executors = {
    "codex-acp": { adapter: "agent", agent: "codex", runner: { transport: "acp" } }
  };
  return manifest;
}

describe("distributed server composition cleanup", () => {
  it("closes SQLite and unbinds runtimes when WebSocket cleanup fails", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    const dataDirectory = join(workspace.root, "server-data");
    const config = parseServerConfig({
      version: "server-config/v1",
      bind: { host: "127.0.0.1", port: 7_443 },
      publicUrl: "http://127.0.0.1:7443",
      allowInsecureDevelopment: true,
      dataDirectory,
      trustedProjects: [
        {
          projectId: workspace.init.workspace.id,
          canvasId: "default",
          projectRoot: workspace.root
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
    });
    const composition = await createDistributedServerComposition({
      httpServer: createServer(),
      config
    });
    await seedOperatorSessions(config.databasePath, config.operatorCredentials);

    await expect(composition.close()).rejects.toThrow("distributed_server_cleanup_failed");
    expect(cleanupSpies.webSocketClose).toHaveBeenCalledOnce();
    expect(cleanupSpies.retentionStart).toHaveBeenCalledOnce();
    expect(cleanupSpies.retentionClose).toHaveBeenCalledOnce();
    expect(cleanupSpies.runtimeRegistryClose).toHaveBeenCalledOnce();
    expect(composition.readiness()).toMatchObject({ status: "draining" });
    await expect(composition.close()).rejects.toThrow("distributed_server_cleanup_failed");
    expect(cleanupSpies.webSocketClose).toHaveBeenCalledOnce();
    expect(cleanupSpies.retentionClose).toHaveBeenCalledOnce();
    expect(cleanupSpies.runtimeRegistryClose).toHaveBeenCalledOnce();
  });
});
