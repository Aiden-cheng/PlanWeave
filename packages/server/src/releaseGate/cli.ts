import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_GATE_ROLLBACK_CHECKS, RELEASE_GATE_TIERS } from "./checklist.js";
import {
  buildReleaseGateReport,
  writeReleaseGateReport,
  type ReleaseGateReport
} from "./evidence.js";
import { runDeterministicProcessSuite } from "./runDeterministic.js";

export type ReleaseGateCliIo = { stdout(value: string): void; stderr(value: string): void };

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

async function readMonorepoPackageVersion(
  packageDirName: "agent-host" | "agent-host-protocol"
): Promise<string | null> {
  // packages/server/src/releaseGate -> packages/<name>/package.json
  const candidate = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    packageDirName,
    "package.json"
  );
  try {
    const raw = await readFile(candidate, "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * planweave-server release-gate
 *   [--checklist]
 *   [--run-deterministic [--deterministic-evidence <path>]]
 *   [--deterministic-evidence <path>]
 *   [--real-acp-evidence <path>]
 *   [--vps-evidence <path>]
 *   [--agent-host-version <semver>]
 *   [--protocol-version <semver>]
 *   [--report <path>]
 *
 * Exit codes:
 *   0  pre-release ready, or CI-only success when only --run-deterministic was requested
 *   1  not release-ready
 *   2  usage error
 *
 * Skipped live evidence never counts as pass.
 */
export async function runReleaseGateCli(
  argv: readonly string[],
  options: {
    io?: ReleaseGateCliIo;
    env?: Readonly<Record<string, string | undefined>>;
    now?: Date;
  } = {}
): Promise<number> {
  const io = options.io ?? { stdout: console.log, stderr: console.error };

  const known = new Set([
    "--checklist",
    "--run-deterministic",
    "--deterministic-evidence",
    "--real-acp-evidence",
    "--vps-evidence",
    "--agent-host-version",
    "--protocol-version",
    "--report"
  ]);
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!known.has(value)) {
      io.stderr("server_release_gate_cli_usage");
      return 2;
    }
    if (value === "--checklist" || value === "--run-deterministic") continue;
    index++;
  }

  if (argv.includes("--checklist") && argv.length === 1) {
    io.stdout(
      JSON.stringify(
        {
          version: "planweave.release-gate.checklist/v1",
          tiers: RELEASE_GATE_TIERS,
          rollback: RELEASE_GATE_ROLLBACK_CHECKS,
          rules: {
            skippedLiveIsNotPass: true,
            storeOnlySanitizedSummaries: true,
            neverEmbedSecrets: true
          }
        },
        null,
        2
      )
    );
    return 0;
  }

  let deterministicEvidencePath = option(argv, "--deterministic-evidence");
  if (argv.includes("--run-deterministic")) {
    const evidence = await runDeterministicProcessSuite({
      evidencePath: deterministicEvidencePath,
      env: options.env
    });
    if (!deterministicEvidencePath) {
      const dir = await mkdtemp(join(tmpdir(), "planweave-release-gate-"));
      deterministicEvidencePath = join(dir, "deterministic.json");
      await writeFile(deterministicEvidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
        mode: 0o600
      });
    }
  }

  const agentHostVersion =
    option(argv, "--agent-host-version") ?? (await readMonorepoPackageVersion("agent-host"));
  const protocolPackageVersion =
    option(argv, "--protocol-version") ?? (await readMonorepoPackageVersion("agent-host-protocol"));

  const report: ReleaseGateReport = await buildReleaseGateReport({
    deterministicEvidencePath,
    realAcpEvidencePath: option(argv, "--real-acp-evidence"),
    vpsEvidencePath: option(argv, "--vps-evidence"),
    agentHostVersion,
    protocolPackageVersion,
    now: options.now
  });

  const reportPath = option(argv, "--report");
  if (reportPath) await writeReleaseGateReport(reportPath, report);

  io.stdout(JSON.stringify(report, null, 2));

  if (report.releaseReady.preRelease) return 0;
  // CI-only path: running deterministic suite alone should succeed when CI ready.
  if (
    argv.includes("--run-deterministic") &&
    !option(argv, "--real-acp-evidence") &&
    !option(argv, "--vps-evidence") &&
    report.releaseReady.ci
  ) {
    return 0;
  }
  // Evaluation-only with full evidence set: any non-preRelease is exit 1.
  // Checklist+evaluate without live evidence is intentionally not ready.
  if (
    !option(argv, "--deterministic-evidence") &&
    !option(argv, "--real-acp-evidence") &&
    !option(argv, "--vps-evidence") &&
    !argv.includes("--run-deterministic")
  ) {
    // Pure checklist dump already handled; bare `release-gate` prints readiness report.
    return report.releaseReady.preRelease ? 0 : 1;
  }
  return 1;
}
