import { runAgentHostCli } from "@planweave-ai/agent-host";

const serviceFlag = "--agent-host-service";

export function parseDesktopAgentHostServiceArgs(argv: readonly string[]): string[] | null {
  const index = argv.indexOf(serviceFlag);
  if (index < 0) return null;
  const args = argv.slice(index + 1);
  if (args.length === 0) throw new Error("desktop_agent_host_service_args_required");
  return args;
}

export async function runDesktopAgentHostServiceMode(
  argv: readonly string[],
  run: typeof runAgentHostCli = runAgentHostCli
): Promise<number | null> {
  const args = parseDesktopAgentHostServiceArgs(argv);
  return args ? run(args) : null;
}
