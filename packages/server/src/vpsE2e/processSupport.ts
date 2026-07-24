import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { spawnManagedProcess, type ManagedProcessTree } from "@planweave-ai/runtime";
import { redactSensitiveText } from "./redaction.js";

const requireFromHere = createRequire(import.meta.url);

export type ProcessLogBuffer = { stdout: string; stderr: string };
export type ProcessExitSnapshot = { code: number | null; signal: NodeJS.Signals | null };

export type ManagedChild = {
  child: ChildProcessWithoutNullStreams;
  tree: ManagedProcessTree;
  logs: ProcessLogBuffer;
  exit: Promise<ProcessExitSnapshot>;
  exitSnapshot: ProcessExitSnapshot | undefined;
};

export type HostCommandResult = { code: number; stdout: string; stderr: string };

export async function allocateEphemeralPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("vps_e2e_port_unavailable");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

export async function waitFor(
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
  throw new Error(
    `vps_e2e_timeout:${options.label}${options.diagnostics ? `\n${options.diagnostics()}` : ""}${
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

export function spawnLongLived(options: {
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  graceMs?: number;
  logDir?: string;
  label?: string;
}): ManagedChild {
  const managed = spawnManagedProcess({
    command: options.command,
    args: [...options.args],
    env: options.env ?? { ...process.env },
    graceMs: options.graceMs ?? 500
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
  if (options.logDir && options.label) {
    const label = options.label;
    const logDir = options.logDir;
    void exit.then(async (snapshot) => {
      await mkdir(logDir, { recursive: true });
      await writeFile(
        join(logDir, `${label}-exit.json`),
        JSON.stringify({ ...snapshot, at: new Date().toISOString() }, null, 2),
        "utf8"
      );
      await writeFile(
        join(logDir, `${label}.stdout.log`),
        redactSensitiveText(logs.stdout),
        "utf8"
      );
      await writeFile(
        join(logDir, `${label}.stderr.log`),
        redactSensitiveText(logs.stderr),
        "utf8"
      );
    });
  }
  return handle;
}

export function runNodeBin(
  binPath: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<HostCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...argv], {
      stdio: ["ignore", "pipe", "pipe"],
      env
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
        stdout: redactSensitiveText(stdout),
        stderr: redactSensitiveText(stderr)
      });
    });
  });
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function openSqlite(path: string) {
  const { DatabaseSync } = requireFromHere("node:sqlite") as {
    DatabaseSync: new (
      path: string,
      options?: { readOnly?: boolean }
    ) => {
      prepare(sql: string): {
        get(...values: unknown[]): Record<string, unknown> | undefined;
        all(...values: unknown[]): Array<Record<string, unknown>>;
      };
      close(): void;
    };
  };
  return new DatabaseSync(path, { readOnly: true });
}

export function assertBinsPresent(serverBin: string, hostBin: string): void {
  if (!existsSync(serverBin) || !existsSync(hostBin)) {
    throw new Error("vps_e2e_bins_missing");
  }
}
