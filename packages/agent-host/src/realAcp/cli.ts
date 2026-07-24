import { parseRealAcpGate } from "./gate.js";
import { listSupportedHostAcpProfiles } from "./supportedProfiles.js";
import { runRealAcpSmoke } from "./smoke.js";

export type RealAcpCliIo = {
  stdout(value: string): void;
  stderr(value: string): void;
};

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

/**
 * Opt-in real ACP smoke CLI (no coordinator config required).
 *
 * Usage:
 *   planweave-agent-host real-acp-smoke [--evidence <path>] [--profile <id>] [--require]
 *
 * Gate:
 *   PLANWEAVE_REAL_ACP=1             soft (missing binary/auth → skipped evidence, exit 0)
 *   PLANWEAVE_REAL_ACP_REQUIRE=1     hard (missing binary/auth → failed evidence, exit 1)
 *   --require                        same as PLANWEAVE_REAL_ACP_REQUIRE=1 for this invocation
 *   PLANWEAVE_REAL_ACP_PROFILE / --profile   select Host-local profile id
 */
export async function runRealAcpSmokeCli(
  argv: readonly string[],
  options: {
    io?: RealAcpCliIo;
    env?: Readonly<Record<string, string | undefined>>;
  } = {}
): Promise<number> {
  const io = options.io ?? { stdout: console.log, stderr: console.error };
  const env = { ...(options.env ?? process.env) };
  if (argv.includes("--require")) {
    env.PLANWEAVE_REAL_ACP_REQUIRE = "1";
  }
  const profile = option(argv, "--profile");
  if (profile) env.PLANWEAVE_REAL_ACP_PROFILE = profile;
  // Invoking the command is an explicit opt-in even without env when --require or --profile is set;
  // otherwise require PLANWEAVE_REAL_ACP so default CI never hits real agents.
  if (!env.PLANWEAVE_REAL_ACP && !env.PLANWEAVE_REAL_ACP_REQUIRE) {
    env.PLANWEAVE_REAL_ACP = "1";
  }

  const known = new Set(["--evidence", "--profile", "--require", "--list-profiles"]);
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!known.has(value)) {
      io.stderr("agent_host_cli_usage");
      return 2;
    }
    if (value !== "--require" && value !== "--list-profiles") index++;
  }

  if (argv.includes("--list-profiles")) {
    io.stdout(
      JSON.stringify(
        {
          profiles: listSupportedHostAcpProfiles().map((item) => ({
            profileId: item.profileId,
            agentId: item.agentId,
            command: item.command,
            verifiedAdapterVersion: item.verifiedAdapterVersion,
            registryId: item.registryId
          }))
        },
        null,
        2
      )
    );
    return 0;
  }

  const evidencePath = option(argv, "--evidence");
  const gate = parseRealAcpGate(env);
  const evidence = await runRealAcpSmoke({ gate, env, evidencePath });
  io.stdout(JSON.stringify(evidence, null, 2));
  if (evidence.result === "passed" || evidence.result === "skipped") return 0;
  return 1;
}
