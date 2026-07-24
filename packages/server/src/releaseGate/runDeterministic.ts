import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serverPackageVersion } from "../packageInfo.js";

const DETERMINISTIC_TEST_FILES = [
  "packages/server/src/__tests__/realProcessAcpHarness.test.ts",
  "packages/server/src/__tests__/realProcessRemoteBlockLifecycle.test.ts",
  "packages/server/src/__tests__/realProcessCrashReplayMatrix.test.ts",
  "packages/server/src/__tests__/realProcessAuthorizationMatrix.test.ts"
] as const;

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
  const args = ["exec", "vitest", "run", "--reporter=json", ...DETERMINISTIC_TEST_FILES];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    // Never promote live gates from a deterministic run.
    PLANWEAVE_REAL_ACP: undefined,
    PLANWEAVE_REAL_ACP_REQUIRE: undefined,
    PLANWEAVE_VPS_E2E: undefined,
    PLANWEAVE_VPS_E2E_REQUIRE: undefined
  };

  const { exitCode, stdout, stderr } = await new Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>((resolvePromise) => {
    const child = spawn(pnpm, args, {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdoutBuf = "";
    let stderrBuf = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuf += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderrBuf += chunk;
    });
    child.on("error", (error) => {
      resolvePromise({
        exitCode: 1,
        stdout: stdoutBuf,
        stderr: `${stderrBuf}\n${error.message}`
      });
    });
    child.on("close", (code) => {
      resolvePromise({
        exitCode: code ?? 1,
        stdout: stdoutBuf,
        stderr: stderrBuf
      });
    });
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
    commandSanitized: `pnpm exec vitest run ${DETERMINISTIC_TEST_FILES.join(" ")}`,
    exitCode,
    tests: { total, passed, failed },
    diagnostic:
      exitCode === 0
        ? null
        : `Deterministic suite failed (exit ${exitCode}). ${stderr.trim().slice(0, 400)}`
  };

  if (options.evidencePath) {
    await writeFile(options.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
      mode: 0o600
    });
  }
  return evidence;
}
