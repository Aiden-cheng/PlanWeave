import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnManagedProcess } from "@planweave-ai/runtime";
import { serverPackageVersion } from "../packageInfo.js";

const DETERMINISTIC_TEST_FILES = [
  "packages/server/src/__tests__/realProcessAcpHarness.test.ts",
  "packages/server/src/__tests__/realProcessRemoteBlockLifecycle.test.ts",
  "packages/server/src/__tests__/realProcessCrashReplayMatrix.test.ts",
  "packages/server/src/__tests__/realProcessAuthorizationMatrix.test.ts"
] as const;

export const DETERMINISTIC_SUITE_TIMEOUT_MS = 180_000;

export async function runBoundedReleaseGateCommand(options: {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  graceMs?: number;
}): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`release_gate_timeout_invalid:${String(options.timeoutMs)}`);
  }
  const managed = spawnManagedProcess({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
    graceMs: options.graceMs
  });
  const { child } = managed;
  child.stdin.end();
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

  const exit = new Promise<number>((resolveExit) => {
    child.once("error", (error) => {
      stderr += `${stderr ? "\n" : ""}${error.message}`;
      resolveExit(1);
    });
    child.once("close", (code) => resolveExit(code ?? 1));
  });
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timed_out">((resolveTimeout) => {
    timeoutHandle = setTimeout(() => resolveTimeout("timed_out"), options.timeoutMs);
  });
  const outcome = await Promise.race([
    exit.then((exitCode) => ({ kind: "exited" as const, exitCode })),
    timeout.then(() => ({ kind: "timed_out" as const }))
  ]);
  if (timeoutHandle) clearTimeout(timeoutHandle);

  if (outcome.kind === "exited") {
    return { exitCode: outcome.exitCode, stdout, stderr, timedOut: false };
  }

  try {
    await managed.tree.terminate("release gate deterministic suite timeout");
  } catch (error) {
    stderr += `${stderr ? "\n" : ""}${error instanceof Error ? error.message : String(error)}`;
  }
  await exit;
  return { exitCode: 1, stdout, stderr, timedOut: true };
}

export type DeterministicSuiteEvidence = {
  version: "planweave.release-gate.deterministic/v1";
  result: "passed" | "failed";
  generatedAt: string;
  suite: "server-real-process";
  serverVersion: string;
  commandSanitized: string;
  exitCode: number;
  tests: {
    total: number | null;
    passed: number | null;
    failed: number | null;
  };
  diagnostic: string | null;
};

function defaultRepoRoot(): string {
  // packages/server/src/releaseGate -> repo root is ../../../..
  return resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
}

/**
 * Run the deterministic multi-process suite (required CI tier).
 * Does not enable REAL_ACP or VPS_E2E gates.
 */
export async function runDeterministicProcessSuite(options: {
  repoRoot?: string;
  evidencePath?: string;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<DeterministicSuiteEvidence> {
  const repoRoot = options.repoRoot ?? defaultRepoRoot();
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const args = [
    "exec",
    "vitest",
    "run",
    "--reporter=json",
    "--maxWorkers=2",
    ...DETERMINISTIC_TEST_FILES
  ];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    // Never promote live gates from a deterministic run.
    PLANWEAVE_REAL_ACP: undefined,
    PLANWEAVE_REAL_ACP_REQUIRE: undefined,
    PLANWEAVE_VPS_E2E: undefined,
    PLANWEAVE_VPS_E2E_REQUIRE: undefined
  };

  const { exitCode, stdout, stderr, timedOut } = await runBoundedReleaseGateCommand({
    command: pnpm,
    args,
    cwd: repoRoot,
    env,
    timeoutMs: DETERMINISTIC_SUITE_TIMEOUT_MS
  });

  let total: number | null = null;
  let passed: number | null = null;
  let failed: number | null = null;
  try {
    const jsonStart = stdout.indexOf("{");
    if (jsonStart >= 0) {
      const report = JSON.parse(stdout.slice(jsonStart)) as {
        numTotalTests?: number;
        numPassedTests?: number;
        numFailedTests?: number;
      };
      total = report.numTotalTests ?? null;
      passed = report.numPassedTests ?? null;
      failed = report.numFailedTests ?? null;
    }
  } catch {
    // JSON reporter parse is best-effort; exit code remains authoritative.
  }

  const evidence: DeterministicSuiteEvidence = {
    version: "planweave.release-gate.deterministic/v1",
    result: exitCode === 0 ? "passed" : "failed",
    generatedAt: new Date().toISOString(),
    suite: "server-real-process",
    serverVersion: serverPackageVersion,
    commandSanitized: `pnpm exec vitest run --maxWorkers=2 ${DETERMINISTIC_TEST_FILES.join(" ")}`,
    exitCode,
    tests: { total, passed, failed },
    diagnostic:
      exitCode === 0
        ? null
        : timedOut
          ? `Deterministic suite timed out after ${DETERMINISTIC_SUITE_TIMEOUT_MS}ms and its process tree was terminated.`
          : `Deterministic suite failed (exit ${exitCode}). ${stderr.trim().slice(0, 400)}`
  };

  if (options.evidencePath) {
    await writeFile(options.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
      mode: 0o600
    });
  }
  return evidence;
}
