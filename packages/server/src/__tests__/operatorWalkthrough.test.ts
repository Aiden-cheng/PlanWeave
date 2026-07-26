import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlanPackageManifest } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { latestCentralSchemaVersion } from "../migrations.js";
import { hashOperatorToken } from "../operatorAuth.js";

const directories: string[] = [];
const mockAgentPath = fileURLToPath(
  new URL("../../../runtime/src/__tests__/support/acpMockAgent.mjs", import.meta.url)
);

/**
 * Resolve a package's public bin entry from package.json (not a hardcoded dist path).
 * The walkthrough must exercise the same bin surface operators install.
 */
function resolvePublicPackageBin(packageRoot: string, binName: string): string {
  const packageJsonPath = join(packageRoot, "package.json");
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const relative = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[binName];
  if (!relative) {
    throw new Error(`public_bin_field_missing:${binName}`);
  }
  const absolute = join(packageRoot, relative);
  if (!existsSync(absolute)) {
    throw new Error(`public_bin_missing:${binName}:${absolute}`);
  }
  return absolute;
}

const serverPackageRoot = fileURLToPath(new URL("../..", import.meta.url));
const agentHostPackageRoot = fileURLToPath(new URL("../../../agent-host", import.meta.url));
const serverBinPath = resolvePublicPackageBin(serverPackageRoot, "planweave-server");
const agentHostBinPath = resolvePublicPackageBin(agentHostPackageRoot, "planweave-agent-host");

afterEach(async () => {
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
  manifest.nodes[0].blocks[0].requirements = { capabilities: ["acp.test"] };
  return manifest;
}

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("expected_http_port");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

type HostCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type RunningPublicBin = {
  child: ChildProcessWithoutNullStreams;
  result: Promise<number>;
  logs: { stdout: string; stderr: string };
};

/**
 * Invoke a public package binary as a subprocess (planweave-server / planweave-agent-host).
 * Avoids in-process Server CLI imports and Host source imports across package boundaries.
 */
function runPublicBin(binPath: string, argv: readonly string[]): Promise<HostCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...argv], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function runAgentHostBin(argv: readonly string[]): Promise<HostCommandResult> {
  return runPublicBin(agentHostBinPath, argv);
}

function startPublicBin(binPath: string, argv: readonly string[]): RunningPublicBin {
  const child = spawn(process.execPath, [binPath, ...argv], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    logs.stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    logs.stderr += chunk;
  });
  const result = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  return { child, result, logs };
}

async function startServerBin(configPath: string, publicUrl: string): Promise<RunningPublicBin> {
  const running = startPublicBin(serverBinPath, ["serve", "--config", configPath]);
  await vi.waitFor(
    () => {
      const line = running.logs.stdout
        .split("\n")
        .map((value) => value.trim())
        .find((value) => value.startsWith("{") && value.includes("status"));
      if (!line) {
        throw new Error(
          `server_not_ready:${running.logs.stderr || running.logs.stdout || "no_output"}`
        );
      }
      const parsed = JSON.parse(line) as { status?: string; publicUrl?: string };
      expect(parsed).toMatchObject({ status: "ready", publicUrl });
    },
    { timeout: 15_000 }
  );
  return running;
}

function startAgentHostBin(configPath: string): RunningPublicBin {
  return startPublicBin(agentHostBinPath, ["run", "--config", configPath]);
}

async function stopPublicBin(running: RunningPublicBin): Promise<void> {
  if (!running.child.killed) {
    running.child.kill("SIGTERM");
  }
  await expect(running.result).resolves.toBe(0);
}

describe("remote operator walkthrough", () => {
  it("starts Server, preflights/enrolls Host, observes capacity, and stops/restarts cleanly", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    const temporaryRoot = await mkdtemp(join(tmpdir(), "planweave-operator-walkthrough-"));
    directories.push(temporaryRoot);
    const hostWorkspaceRoot = join(temporaryRoot, "workspaces");
    await mkdir(join(hostWorkspaceRoot, "project"), { recursive: true });
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const operatorToken = "walkthrough_operator_token_abcdefghijklmnopqrstuvwxyz";
    const serverConfigPath = join(temporaryRoot, "server.json");
    await writeFile(
      serverConfigPath,
      JSON.stringify({
        version: "server-config/v1",
        bind: { host: "127.0.0.1", port },
        publicUrl: origin,
        allowInsecureDevelopment: true,
        dataDirectory: join(temporaryRoot, "server-data"),
        trustedProjects: [
          {
            projectId: workspace.init.workspace.id,
            canvasId: "default",
            projectRoot: workspace.root
          }
        ],
        operatorCredentials: [
          {
            operatorId: "walkthrough-operator",
            tokenSha256: hashOperatorToken(operatorToken),
            projectIds: [],
            serverAdmin: true
          }
        ]
      })
    );

    let server = await startServerBin(serverConfigPath, origin);
    const authorization = { Authorization: `Bearer ${operatorToken}` };
    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
    const readiness = await fetch(`${origin}/readyz`);
    expect(readiness.status).toBe(200);
    await expect(readiness.json()).resolves.toEqual({
      status: "ready",
      schemaVersion: latestCentralSchemaVersion
    });
    await expect((await fetch(`${origin}/version`)).json()).resolves.toMatchObject({
      protocolVersion: 1
    });

    const enrollmentExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const credentialExpiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const grantResponse = await fetch(`${origin}/api/v1/host-enrollments`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({
        expiresAt: enrollmentExpiresAt,
        credentialExpiresAt
      })
    });
    expect(grantResponse.status).toBe(201);
    const grant = (await grantResponse.json()) as { enrollmentCode: string };
    expect(grant.enrollmentCode).toMatch(/^pw_enroll_/);

    const hostConfigPath = join(temporaryRoot, "agent-host.json");
    await writeFile(
      hostConfigPath,
      JSON.stringify({
        version: "agent-host-config/v1",
        coordinator: { url: origin, allowInsecureDevelopment: true },
        dataDirectory: join(temporaryRoot, "host-data"),
        workspaceRoot: hostWorkspaceRoot,
        host: {
          displayName: "Walkthrough Host",
          capacity: 2,
          capabilities: ["acp.test"]
        },
        workspaces: [{ id: workspace.init.workspace.id, path: "project" }],
        agentProfiles: [
          {
            id: "codex-acp",
            agentId: "codex",
            command: process.execPath,
            args: [mockAgentPath, "success"],
            environment: []
          }
        ]
      })
    );

    const preflight = await runAgentHostBin(["preflight", "--config", hostConfigPath]);
    expect(preflight.code).toBe(0);
    expect(JSON.parse(preflight.stdout)).toMatchObject({
      credential: "missing",
      capacity: 2,
      connection: "offline"
    });

    const enrollment = await runAgentHostBin([
      "enroll",
      "--config",
      hostConfigPath,
      "--code",
      grant.enrollmentCode
    ]);
    expect(enrollment.code).toBe(0);
    expect(JSON.parse(enrollment.stdout)).toMatchObject({ credential: "active" });

    const status = await runAgentHostBin(["status", "--config", hostConfigPath]);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      credential: "active",
      capacity: 2
    });

    const readHost = async () => {
      const response = await fetch(`${origin}/api/v1/hosts`, { headers: authorization });
      expect(response.status).toBe(200);
      const page = (await response.json()) as {
        items: Array<{
          id: string;
          capacity: number;
          displayName: string;
          lastSeenAt?: string;
          revokedAt?: string;
        }>;
      };
      return page.items[0];
    };

    let host = startAgentHostBin(hostConfigPath);
    let firstLastSeenAt: string | undefined;
    let hostId: string | undefined;
    await vi.waitFor(async () => {
      const observedHost = await readHost();
      expect(observedHost).toMatchObject({
        displayName: "Walkthrough Host",
        capacity: 2,
        lastSeenAt: expect.any(String)
      });
      firstLastSeenAt = observedHost.lastSeenAt;
      hostId = observedHost.id;
    });
    expect(hostId).toBeTruthy();

    // Operator dispatch proof: HTTP 202 only means the Coordinator accepted the request.
    // Production success requires Host acceptance (leased/running) and a terminal outcome.
    const dispatchResponse = await fetch(`${origin}/api/v1/remote-operations`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({
        projectId: workspace.init.workspace.id,
        canvasId: "default",
        blockRef: "T-001#B-001",
        idempotencyKey: "operator-walkthrough-dispatch"
      })
    });
    expect(dispatchResponse.status).toBe(202);
    const dispatched = (await dispatchResponse.json()) as {
      operationId: string;
      projectId: string;
      blockRef: string;
      dispatchStatus?: string;
      state?: string;
    };
    expect(dispatched).toMatchObject({
      projectId: workspace.init.workspace.id,
      blockRef: "T-001#B-001",
      operationId: expect.any(String)
    });

    type OperatorOperationView = {
      operationId: string;
      blockRef: string;
      state: string;
      dispatchStatus?: string;
      attempt?: { status?: string; hostId?: string };
    };

    const observeOperation = async (operationId: string): Promise<OperatorOperationView> => {
      const response = await fetch(
        `${origin}/api/v1/remote-operations/${encodeURIComponent(operationId)}`,
        { headers: authorization }
      );
      expect(response.status).toBe(200);
      return (await response.json()) as OperatorOperationView;
    };

    // Host accepted: dispatch.accepted surfaces as leased/running (may already be terminal).
    const accepted = await vi.waitFor(
      async () => {
        const view = await observeOperation(dispatched.operationId);
        expect(["leased", "running", "completed"]).toContain(view.dispatchStatus);
        return view;
      },
      { timeout: 20_000 }
    );
    expect(accepted.attempt?.hostId).toBe(hostId);

    // Terminal: request acceptance is not success; wait for completed/failed/cancelled.
    const terminal = await vi.waitFor(
      async () => {
        const view = await observeOperation(dispatched.operationId);
        expect(["completed", "failed", "cancelled"]).toContain(view.state);
        return view;
      },
      { timeout: 30_000 }
    );
    expect(terminal).toMatchObject({
      operationId: dispatched.operationId,
      blockRef: "T-001#B-001",
      state: "completed",
      dispatchStatus: "completed"
    });

    await stopPublicBin(host);

    host = startAgentHostBin(hostConfigPath);
    await vi.waitFor(async () => {
      expect((await readHost()).lastSeenAt).not.toBe(firstLastSeenAt);
    });
    await stopPublicBin(host);
    await stopPublicBin(server);

    server = await startServerBin(serverConfigPath, origin);
    await expect((await fetch(`${origin}/readyz`)).json()).resolves.toEqual({
      status: "ready",
      schemaVersion: latestCentralSchemaVersion
    });
    const hosts = (await (
      await fetch(`${origin}/api/v1/hosts`, { headers: authorization })
    ).json()) as { items: Array<{ id: string }> };
    const serverRevocation = await fetch(
      `${origin}/api/v1/hosts/${encodeURIComponent(hosts.items[0].id)}/revoke`,
      { method: "POST", headers: authorization }
    );
    expect(serverRevocation.status).toBe(200);
    await expect(serverRevocation.json()).resolves.toMatchObject({
      id: hosts.items[0].id,
      revokedAt: expect.any(String)
    });

    const statusAfterServerRevocation = await runAgentHostBin([
      "status",
      "--config",
      hostConfigPath
    ]);
    expect(statusAfterServerRevocation.code).toBe(0);
    // Local credential store is independent until the Host marks or replaces it.
    expect(JSON.parse(statusAfterServerRevocation.stdout)).toMatchObject({
      credential: "active"
    });
    const localRevocation = await runAgentHostBin(["revoke", "--config", hostConfigPath]);
    expect(localRevocation.code).toBe(0);
    expect(JSON.parse(localRevocation.stdout)).toMatchObject({
      credential: "revoked"
    });
    await stopPublicBin(server);
  }, 60_000);
});
