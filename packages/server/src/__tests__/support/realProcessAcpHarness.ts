/**
 * Real multi-process ACP integration harness.
 *
 * Topology (all OS processes unless noted):
 *   test runner
 *     ├─ planweave-server (dist/bin.js serve)  — HTTP/WSS + SQLite dataDirectory
 *     ├─ planweave-agent-host (dist/bin.js run) — enroll/run against public APIs
 *     │    └─ fake ACP (acpMockAgent.mjs) — real stdio JSON-RPC; optional control-dir
 *     └─ harness-owned temp root (project, workspaces, state, artifacts, logs, control)
 *
 * Determinism: explicit readiness (/readyz + host lastSeenAt), ACP control-dir barriers,
 * and scripted mock scenarios — not sleeps-as-authority. No production debug endpoints.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnManagedProcess, type ManagedProcessTree } from "@planweave-ai/runtime";
import type { PlanPackageManifest } from "@planweave-ai/runtime";
import { redactRunnerEventText } from "@planweave-ai/runtime";
import {
  basicManifest,
  createTestWorkspace
} from "../../../../runtime/src/__tests__/promptTestHelpers.js";
import { hashOperatorToken } from "../../operatorAuth.js";

const serverBinPath = fileURLToPath(new URL("../../../dist/bin.js", import.meta.url));
const agentHostBinPath = fileURLToPath(
  new URL("../../../../agent-host/dist/bin.js", import.meta.url)
);
export const acpMockAgentPath = fileURLToPath(
  new URL("../../../../runtime/src/__tests__/support/acpMockAgent.mjs", import.meta.url)
);

export const REAL_PROCESS_ACP_HARNESS_DEFAULT_TIMEOUT_MS = 15_000;

export type ProcessLogBuffer = {
  stdout: string;
  stderr: string;
};

export type ProcessExitSnapshot = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type ManagedChild = {
  child: ChildProcessWithoutNullStreams;
  tree: ManagedProcessTree;
  logs: ProcessLogBuffer;
  exit: Promise<ProcessExitSnapshot>;
  exitSnapshot: ProcessExitSnapshot | undefined;
};

export type RealProcessAcpHarnessOptions = {
  acpScenario?: string;
  hostDisplayName?: string;
  hostCapacity?: number;
  hostCapabilities?: string[];
  operatorToken?: string;
  readinessTimeoutMs?: number;
  /** When true, write intentionally invalid server config for failed-startup tests. */
  corruptServerConfigOnCreate?: boolean;
  graceMs?: number;
};

export type HarnessPaths = {
  root: string;
  projectRoot: string;
  projectHome: string;
  serverData: string;
  hostData: string;
  workspaceRoot: string;
  workspaceProject: string;
  artifacts: string;
  logs: string;
  control: string;
  serverConfig: string;
  hostConfig: string;
  acpLifecycle: string;
};

export type HostCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function redactLogText(value: string): string {
  try {
    return redactRunnerEventText(value).text;
  } catch {
    return value.replace(
      /\b(?:token|password|api[_-]?key|secret|authorization)\s*[:=]\s*\S+/gi,
      "credential=[REDACTED:CREDENTIAL]"
    );
  }
}

export async function allocateEphemeralPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("real_process_harness_port_unavailable");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

export function remoteAcpManifest(): PlanPackageManifest {
  const manifest = basicManifest();
  manifest.execution.defaultExecutor = "codex-acp";
  manifest.executors = {
    "codex-acp": { adapter: "agent", agent: "codex", runner: { transport: "acp" } }
  };
  manifest.nodes[0].blocks[0].requirements = { capabilities: ["acp.test"] };
  return manifest;
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  options: { timeoutMs: number; intervalMs?: number; label: string; diagnostics?: () => string }
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  const intervalMs = options.intervalMs ?? 50;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const detail = options.diagnostics?.() ?? "";
  throw new Error(
    `real_process_harness_timeout:${options.label}${detail ? `\n${detail}` : ""}${
      lastError instanceof Error ? `\ncause: ${lastError.message}` : ""
    }`
  );
}

function attachLogCapture(child: ChildProcessWithoutNullStreams): ProcessLogBuffer {
  const logs: ProcessLogBuffer = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    logs.stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    logs.stderr += chunk;
  });
  return logs;
}

function trackExit(child: ChildProcessWithoutNullStreams): {
  exit: Promise<ProcessExitSnapshot>;
  getSnapshot: () => ProcessExitSnapshot | undefined;
} {
  let snapshot: ProcessExitSnapshot | undefined;
  const exit = new Promise<ProcessExitSnapshot>((resolve) => {
    child.once("exit", (code, signal) => {
      snapshot = { code, signal };
      resolve(snapshot);
    });
    child.once("error", () => {
      snapshot = { code: null, signal: null };
      resolve(snapshot);
    });
  });
  return { exit, getSnapshot: () => snapshot };
}

/**
 * File-based control plane for the harness-owned fake ACP process.
 * Production binaries never import this; only acpMockAgent.mjs honors the control dir.
 */
export class FakeAcpControl {
  constructor(readonly controlDir: string) {}

  async pause(at?: readonly string[]): Promise<void> {
    await mkdir(this.controlDir, { recursive: true });
    if (at && at.length > 0) {
      await writeFile(join(this.controlDir, "pause-at"), `${at.join("\n")}\n`, "utf8");
    } else if (existsSync(join(this.controlDir, "pause-at"))) {
      await rm(join(this.controlDir, "pause-at"), { force: true });
    }
    await writeFile(join(this.controlDir, "pause"), "1\n", "utf8");
  }

  async resume(): Promise<void> {
    await rm(join(this.controlDir, "pause"), { force: true });
  }

  async corruptNextStdoutFrame(): Promise<void> {
    await mkdir(this.controlDir, { recursive: true });
    await writeFile(join(this.controlDir, "corrupt-next"), "1\n", "utf8");
  }

  async forceExit(code = 42): Promise<void> {
    await mkdir(this.controlDir, { recursive: true });
    await writeFile(join(this.controlDir, "force-exit"), `${code}\n`, "utf8");
  }

  async waitUntilReady(timeoutMs = REAL_PROCESS_ACP_HARNESS_DEFAULT_TIMEOUT_MS): Promise<void> {
    await waitFor(() => existsSync(join(this.controlDir, "ready")), {
      timeoutMs,
      label: "acp-control-ready",
      diagnostics: () => `controlDir=${this.controlDir}`
    });
  }

  async waitUntilLifecycleContains(
    fragment: string,
    timeoutMs = REAL_PROCESS_ACP_HARNESS_DEFAULT_TIMEOUT_MS
  ): Promise<string[]> {
    const lifecyclePath = join(this.controlDir, "lifecycle.log");
    let lines: string[] = [];
    await waitFor(
      async () => {
        if (!existsSync(lifecyclePath)) return false;
        const text = await readFile(lifecyclePath, "utf8");
        lines = text.split("\n").filter(Boolean);
        return lines.some((line) => line.includes(fragment));
      },
      {
        timeoutMs,
        label: `acp-lifecycle:${fragment}`,
        diagnostics: () => redactLogText(lines.join("\n") || "(empty lifecycle)")
      }
    );
    return lines;
  }

  async readLifecycle(): Promise<string[]> {
    const lifecyclePath = join(this.controlDir, "lifecycle.log");
    if (!existsSync(lifecyclePath)) return [];
    return (await readFile(lifecyclePath, "utf8")).split("\n").filter(Boolean);
  }
}

export class RealProcessAcpHarness {
  readonly paths: HarnessPaths;
  readonly operatorToken: string;
  readonly origin: string;
  readonly port: number;
  readonly projectId: string;
  readonly acpControl: FakeAcpControl;
  readonly acpScenario: string;
  readonly readinessTimeoutMs: number;
  readonly hostDisplayName: string;
  readonly hostCapacity: number;
  readonly hostCapabilities: readonly string[];
  readonly graceMs: number;

  private server: ManagedChild | undefined;
  private host: ManagedChild | undefined;
  private enrolled = false;
  private disposed = false;
  private readonly ownedRoots: string[] = [];

  private constructor(init: {
    paths: HarnessPaths;
    operatorToken: string;
    origin: string;
    port: number;
    projectId: string;
    acpScenario: string;
    readinessTimeoutMs: number;
    hostDisplayName: string;
    hostCapacity: number;
    hostCapabilities: readonly string[];
    graceMs: number;
    ownedRoots: string[];
  }) {
    this.paths = init.paths;
    this.operatorToken = init.operatorToken;
    this.origin = init.origin;
    this.port = init.port;
    this.projectId = init.projectId;
    this.acpScenario = init.acpScenario;
    this.readinessTimeoutMs = init.readinessTimeoutMs;
    this.hostDisplayName = init.hostDisplayName;
    this.hostCapacity = init.hostCapacity;
    this.hostCapabilities = init.hostCapabilities;
    this.graceMs = init.graceMs;
    this.ownedRoots = init.ownedRoots;
    this.acpControl = new FakeAcpControl(init.paths.control);
  }

  static async create(options: RealProcessAcpHarnessOptions = {}): Promise<RealProcessAcpHarness> {
    const operatorToken =
      options.operatorToken ?? "harness_operator_token_abcdefghijklmnopqrstuvwxyz";
    const acpScenario = options.acpScenario ?? "artifact-implementation";
    const readinessTimeoutMs =
      options.readinessTimeoutMs ?? REAL_PROCESS_ACP_HARNESS_DEFAULT_TIMEOUT_MS;
    const hostDisplayName = options.hostDisplayName ?? "Harness Host";
    const hostCapacity = options.hostCapacity ?? 2;
    const hostCapabilities = options.hostCapabilities ?? ["acp.test"];
    const graceMs = options.graceMs ?? 500;

    const workspace = await createTestWorkspace(remoteAcpManifest());
    const root = await mkdtemp(join(tmpdir(), "planweave-real-process-acp-"));
    const ownedRoots = [root, workspace.home, workspace.root];

    const paths: HarnessPaths = {
      root,
      projectRoot: workspace.root,
      projectHome: workspace.home,
      serverData: join(root, "server-data"),
      hostData: join(root, "host-data"),
      workspaceRoot: join(root, "workspaces"),
      workspaceProject: join(root, "workspaces", "project"),
      artifacts: join(root, "artifacts"),
      logs: join(root, "logs"),
      control: join(root, "acp-control"),
      serverConfig: join(root, "server.json"),
      hostConfig: join(root, "agent-host.json"),
      acpLifecycle: join(root, "acp-control", "lifecycle.log")
    };

    // Host credential store requires dataDirectory mode 0700; create it securely.
    await mkdir(paths.serverData, { recursive: true, mode: 0o700 });
    await mkdir(paths.hostData, { recursive: true, mode: 0o700 });
    await mkdir(paths.workspaceProject, { recursive: true });
    await mkdir(paths.artifacts, { recursive: true });
    await mkdir(paths.logs, { recursive: true });
    await mkdir(paths.control, { recursive: true });

    const port = await allocateEphemeralPort();
    const origin = `http://127.0.0.1:${port}`;
    const projectId = workspace.init.workspace.id;

    if (options.corruptServerConfigOnCreate) {
      await writeFile(paths.serverConfig, "{not-valid-server-config\n", "utf8");
    } else {
      await writeFile(
        paths.serverConfig,
        JSON.stringify({
          version: "server-config/v1",
          bind: { host: "127.0.0.1", port },
          publicUrl: origin,
          allowInsecureDevelopment: true,
          dataDirectory: paths.serverData,
          trustedProjects: [
            {
              projectId,
              canvasId: "default",
              projectRoot: paths.projectRoot
            }
          ],
          operatorCredentials: [
            {
              operatorId: "harness-operator",
              tokenSha256: hashOperatorToken(operatorToken),
              projectIds: [],
              serverAdmin: true
            }
          ]
        }),
        "utf8"
      );
    }

    await writeFile(
      paths.hostConfig,
      JSON.stringify({
        version: "agent-host-config/v1",
        coordinator: { url: origin, allowInsecureDevelopment: true },
        dataDirectory: paths.hostData,
        workspaceRoot: paths.workspaceRoot,
        host: {
          displayName: hostDisplayName,
          capacity: hostCapacity,
          capabilities: hostCapabilities
        },
        workspaces: [{ id: projectId, path: "project" }],
        agentProfiles: [
          {
            id: "codex-acp",
            agentId: "codex",
            command: process.execPath,
            args: [acpMockAgentPath, acpScenario, `--control-dir=${paths.control}`],
            environment: []
          }
        ]
      }),
      "utf8"
    );

    return new RealProcessAcpHarness({
      paths,
      operatorToken,
      origin,
      port,
      projectId,
      acpScenario,
      readinessTimeoutMs,
      hostDisplayName,
      hostCapacity,
      hostCapabilities,
      graceMs,
      ownedRoots
    });
  }

  authorizationHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.operatorToken}` };
  }

  redactedServerLogs(): ProcessLogBuffer {
    return {
      stdout: redactLogText(this.server?.logs.stdout ?? ""),
      stderr: redactLogText(this.server?.logs.stderr ?? "")
    };
  }

  redactedHostLogs(): ProcessLogBuffer {
    return {
      stdout: redactLogText(this.host?.logs.stdout ?? ""),
      stderr: redactLogText(this.host?.logs.stderr ?? "")
    };
  }

  serverExitSnapshot(): ProcessExitSnapshot | undefined {
    return this.server?.exitSnapshot;
  }

  hostExitSnapshot(): ProcessExitSnapshot | undefined {
    return this.host?.exitSnapshot;
  }

  serverPid(): number | undefined {
    return this.server?.child.pid;
  }

  hostPid(): number | undefined {
    return this.host?.child.pid;
  }

  /**
   * Injected clocks are not available for production Server/Host binaries.
   * Determinism for real-process tests uses readiness + ACP barriers.
   */
  advanceInjectedClock(_milliseconds: number): never {
    throw new Error("real_process_acp_harness_clock_not_supported");
  }

  private diagnostics(): string {
    const server = this.redactedServerLogs();
    const host = this.redactedHostLogs();
    return [
      `origin=${this.origin}`,
      `serverPid=${String(this.serverPid() ?? "none")} exit=${JSON.stringify(this.serverExitSnapshot() ?? null)}`,
      `hostPid=${String(this.hostPid() ?? "none")} exit=${JSON.stringify(this.hostExitSnapshot() ?? null)}`,
      `server.stdout:\n${server.stdout || "(empty)"}`,
      `server.stderr:\n${server.stderr || "(empty)"}`,
      `host.stdout:\n${host.stdout || "(empty)"}`,
      `host.stderr:\n${host.stderr || "(empty)"}`
    ].join("\n");
  }

  private spawnLongLived(command: string, args: readonly string[], label: string): ManagedChild {
    const managed = spawnManagedProcess({
      command,
      args: [...args],
      env: { ...process.env },
      graceMs: this.graceMs
    });
    const logs = attachLogCapture(managed.child);
    const { exit, getSnapshot } = trackExit(managed.child);
    const handle: ManagedChild = {
      child: managed.child,
      tree: managed.tree,
      logs,
      exit,
      get exitSnapshot() {
        return getSnapshot();
      }
    };
    void exit.then(async (snapshot) => {
      await writeFile(
        join(this.paths.logs, `${label}-exit.json`),
        JSON.stringify({ ...snapshot, at: new Date().toISOString() }, null, 2),
        "utf8"
      );
      await writeFile(join(this.paths.logs, `${label}.stdout.log`), redactLogText(logs.stdout), "utf8");
      await writeFile(join(this.paths.logs, `${label}.stderr.log`), redactLogText(logs.stderr), "utf8");
    });
    return handle;
  }

  async startServer(): Promise<void> {
    if (this.disposed) throw new Error("real_process_harness_disposed");
    if (this.server?.tree.isAlive()) throw new Error("real_process_harness_server_already_running");
    // Drop a dead handle from a previous failed start so callers can retry after fixing config.
    this.server = undefined;
    this.server = this.spawnLongLived(
      process.execPath,
      [serverBinPath, "serve", "--config", this.paths.serverConfig],
      "server"
    );
    await waitFor(
      () => {
        if (this.server?.exitSnapshot) return false;
        try {
          const line = this.server?.logs.stdout
            .split("\n")
            .map((value) => value.trim())
            .find((value) => value.startsWith("{") && value.includes("status"));
          if (!line) return false;
          const parsed = JSON.parse(line) as { status?: string; publicUrl?: string };
          return parsed.status === "ready" && parsed.publicUrl === this.origin;
        } catch {
          return false;
        }
      },
      {
        timeoutMs: this.readinessTimeoutMs,
        label: "server-ready",
        diagnostics: () => this.diagnostics()
      }
    );
  }

  async waitForServerReadyz(): Promise<void> {
    await waitFor(
      async () => {
        const response = await fetch(`${this.origin}/readyz`);
        if (!response.ok) return false;
        const body = (await response.json()) as { status?: string };
        return body.status === "ready";
      },
      {
        timeoutMs: this.readinessTimeoutMs,
        label: "server-readyz",
        diagnostics: () => this.diagnostics()
      }
    );
  }

  async stopServer(reason = "harness stopServer"): Promise<ProcessExitSnapshot | undefined> {
    if (!this.server) return undefined;
    const handle = this.server;
    if (handle.tree.isAlive()) {
      await handle.tree.terminate(reason);
    }
    const snapshot = await handle.exit;
    this.server = undefined;
    return snapshot;
  }

  /** Closes HTTP/WSS by terminating the Server process (no production debug endpoint). */
  async closeServerTransport(reason = "harness closeServerTransport"): Promise<void> {
    await this.stopServer(reason);
  }

  async restartServer(): Promise<void> {
    await this.stopServer("harness restartServer");
    await this.startServer();
    await this.waitForServerReadyz();
  }

  async killServer(signal: NodeJS.Signals = "SIGKILL"): Promise<ProcessExitSnapshot | undefined> {
    if (!this.server) return undefined;
    const handle = this.server;
    if (handle.child.exitCode === null && handle.child.signalCode === null) {
      handle.child.kill(signal);
    }
    const snapshot = await handle.exit;
    this.server = undefined;
    return snapshot;
  }

  async runHostCommand(argv: readonly string[]): Promise<HostCommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [agentHostBinPath, ...argv], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env }
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
        resolve({
          code: code ?? 1,
          stdout: redactLogText(stdout),
          stderr: redactLogText(stderr)
        });
      });
    });
  }

  async enrollHost(): Promise<void> {
    if (this.disposed) throw new Error("real_process_harness_disposed");
    const enrollmentExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const credentialExpiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const grantResponse = await fetch(`${this.origin}/api/v1/host-enrollments`, {
      method: "POST",
      headers: {
        ...this.authorizationHeaders(),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        expiresAt: enrollmentExpiresAt,
        credentialExpiresAt
      })
    });
    if (grantResponse.status !== 201) {
      throw new Error(
        `real_process_harness_enroll_grant_failed:${grantResponse.status}\n${this.diagnostics()}`
      );
    }
    const grant = (await grantResponse.json()) as { enrollmentCode: string };
    const enrollment = await this.runHostCommand([
      "enroll",
      "--config",
      this.paths.hostConfig,
      "--code",
      grant.enrollmentCode
    ]);
    if (enrollment.code !== 0) {
      throw new Error(
        `real_process_harness_enroll_failed:${enrollment.code}\n${enrollment.stderr}\n${this.diagnostics()}`
      );
    }
    this.enrolled = true;
  }

  async startHost(): Promise<void> {
    if (this.disposed) throw new Error("real_process_harness_disposed");
    if (this.host?.tree.isAlive()) throw new Error("real_process_harness_host_already_running");
    this.host = undefined;
    if (!this.enrolled) await this.enrollHost();
    this.host = this.spawnLongLived(
      process.execPath,
      [agentHostBinPath, "run", "--config", this.paths.hostConfig],
      "host"
    );
    await this.waitForHostOnline();
  }

  async waitForHostOnline(options?: {
    lastSeenAtNot?: string;
  }): Promise<{ id: string; lastSeenAt: string }> {
    let observed: { id: string; lastSeenAt: string } | undefined;
    await waitFor(
      async () => {
        const response = await fetch(`${this.origin}/api/v1/hosts`, {
          headers: this.authorizationHeaders()
        });
        if (!response.ok) return false;
        const page = (await response.json()) as {
          items: Array<{ id: string; lastSeenAt?: string; displayName?: string }>;
        };
        const match = page.items.find(
          (item) => item.displayName === this.hostDisplayName && typeof item.lastSeenAt === "string"
        );
        if (!match?.lastSeenAt) return false;
        if (options?.lastSeenAtNot !== undefined && match.lastSeenAt === options.lastSeenAtNot) {
          return false;
        }
        observed = { id: match.id, lastSeenAt: match.lastSeenAt };
        return true;
      },
      {
        timeoutMs: this.readinessTimeoutMs,
        label: options?.lastSeenAtNot ? "host-online-refreshed" : "host-online",
        diagnostics: () => this.diagnostics()
      }
    );
    if (!observed) throw new Error("real_process_harness_host_online_missing");
    return observed;
  }

  async stopHost(reason = "harness stopHost"): Promise<ProcessExitSnapshot | undefined> {
    if (!this.host) return undefined;
    const handle = this.host;
    if (handle.tree.isAlive()) {
      await handle.tree.terminate(reason);
    }
    const snapshot = await handle.exit;
    this.host = undefined;
    return snapshot;
  }

  async restartHost(options?: { previousLastSeenAt?: string }): Promise<{
    id: string;
    lastSeenAt: string;
  }> {
    const previousLastSeenAt =
      options?.previousLastSeenAt ??
      (
        await this.waitForHostOnline().catch(() => undefined)
      )?.lastSeenAt;
    await this.stopHost("harness restartHost");
    // Credential remains in host dataDirectory; do not re-enroll.
    this.host = this.spawnLongLived(
      process.execPath,
      [agentHostBinPath, "run", "--config", this.paths.hostConfig],
      "host"
    );
    return this.waitForHostOnline(
      previousLastSeenAt ? { lastSeenAtNot: previousLastSeenAt } : undefined
    );
  }

  async killHost(signal: NodeJS.Signals = "SIGKILL"): Promise<ProcessExitSnapshot | undefined> {
    if (!this.host) return undefined;
    const handle = this.host;
    if (handle.child.exitCode === null && handle.child.signalCode === null) {
      handle.child.kill(signal);
    }
    const snapshot = await handle.exit;
    this.host = undefined;
    return snapshot;
  }

  /**
   * Full readiness: Server process ready + /readyz + enrolled Host online.
   */
  async startAll(): Promise<void> {
    await this.startServer();
    await this.waitForServerReadyz();
    await this.startHost();
  }

  async corruptScopedPayload(
    kind: "server-config" | "host-config" | "acp-next-frame"
  ): Promise<void> {
    if (kind === "server-config") {
      await writeFile(this.paths.serverConfig, "{corrupt-server-config\n", "utf8");
      return;
    }
    if (kind === "host-config") {
      await writeFile(this.paths.hostConfig, "{corrupt-host-config\n", "utf8");
      return;
    }
    await this.acpControl.corruptNextStdoutFrame();
  }

  /**
   * Spawn the fake ACP executable directly (not via Host) for barrier/control self-tests.
   */
  spawnFakeAcpDirect(scenario = this.acpScenario): ManagedChild {
    return this.spawnLongLived(
      process.execPath,
      [acpMockAgentPath, scenario, `--control-dir=${this.paths.control}`],
      "fake-acp"
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const errors: unknown[] = [];
    try {
      await this.stopHost("harness dispose");
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.stopServer("harness dispose");
    } catch (error) {
      errors.push(error);
    }
    // Best-effort: only remove harness-created roots.
    for (const directory of this.ownedRoots.splice(0)) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new Error(
        `real_process_harness_dispose_failed:${errors
          .map((error) => (error instanceof Error ? error.message : String(error)))
          .join("; ")}`
      );
    }
  }
}
