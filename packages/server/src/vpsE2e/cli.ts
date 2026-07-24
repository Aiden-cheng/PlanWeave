import { parseVpsE2eGate } from "./gate.js";
import { runVpsAuthenticatedE2e } from "./run.js";

export type VpsE2eCliIo = { stdout(value: string): void; stderr(value: string): void };

/**
 * planweave-server vps-e2e [--evidence <path>] [--profile local-tls-fixture|remote-vps] [--require]
 *
 * Soft:  PLANWEAVE_VPS_E2E=1
 * Hard:  PLANWEAVE_VPS_E2E_REQUIRE=1 or --require
 * Config (remote-vps only): PLANWEAVE_VPS_E2E_CONFIG=/absolute/outside-repo.json
 */
export async function runVpsE2eCli(
  argv: readonly string[],
  options: {
    io?: VpsE2eCliIo;
    env?: Record<string, string | undefined>;
  } = {}
): Promise<number> {
  const io = options.io ?? { stdout: console.log, stderr: console.error };
  const env: Record<string, string | undefined> = { ...(options.env ?? process.env) };

  const option = (name: string) => {
    const index = argv.indexOf(name);
    return index < 0 ? undefined : argv[index + 1];
  };

  if (argv.includes("--require")) {
    env.PLANWEAVE_VPS_E2E_REQUIRE = "1";
  }
  const profile = option("--profile");
  if (profile) env.PLANWEAVE_VPS_E2E_PROFILE = profile;

  // CLI invocation implies soft gate when neither soft nor hard is set,
  // matching real-acp-smoke ergonomics. Vitest live suites still require env.
  if (!env.PLANWEAVE_VPS_E2E && !env.PLANWEAVE_VPS_E2E_REQUIRE) {
    env.PLANWEAVE_VPS_E2E = "1";
  }

  const known = new Set(["--evidence", "--profile", "--require"]);
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!known.has(value)) {
      io.stderr("server_vps_e2e_cli_usage");
      return 2;
    }
    if (value !== "--require") index++;
  }

  const evidencePath = option("--evidence");
  const gate = parseVpsE2eGate(env);
  const evidence = await runVpsAuthenticatedE2e({ gate, env, evidencePath });
  io.stdout(JSON.stringify(evidence, null, 2));
  if (evidence.result === "passed" || evidence.result === "skipped") return 0;
  return 1;
}
