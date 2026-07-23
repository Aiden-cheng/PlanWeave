import type { AgentHostComposition } from "../composition/agentHostComposition.js";
import { AgentHostOperator } from "./agentHostOperator.js";

export type AgentHostCliIo = { stdout(value: string): void; stderr(value: string): void };

type ParsedCommand = {
  command: "preflight" | "enroll" | "run" | "status" | "revoke";
  configPath: string;
  code?: string;
  replace: boolean;
};

export interface AgentHostOperatorService {
  preflight(configPath: string): Promise<unknown>;
  enroll(configPath: string, code: string, replaceExisting?: boolean): Promise<unknown>;
  createDaemon(configPath: string): Promise<AgentHostComposition>;
  status(configPath: string): Promise<unknown>;
  revoke(configPath: string): Promise<unknown>;
}

export function parseAgentHostArgs(argv: readonly string[]): ParsedCommand {
  const [command, ...args] = argv;
  if (!command || !["preflight", "enroll", "run", "status", "revoke"].includes(command)) {
    throw new Error("agent_host_cli_usage");
  }
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const configPath = option("--config");
  if (!configPath) throw new Error("agent_host_cli_config_required");
  const code = option("--code");
  if (command === "enroll" && !code) throw new Error("agent_host_cli_enrollment_code_required");
  if (command !== "enroll" && (code || args.includes("--replace"))) {
    throw new Error("agent_host_cli_usage");
  }
  const known = new Set(["--config", "--code", "--replace"]);
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (!known.has(value)) throw new Error("agent_host_cli_usage");
    if (value !== "--replace") index++;
  }
  return {
    command: command as ParsedCommand["command"],
    configPath,
    code,
    replace: args.includes("--replace")
  };
}

export async function waitForAgentHostSignal(
  composition: AgentHostComposition,
  processLike: Pick<NodeJS.Process, "once" | "off">
): Promise<void> {
  let resolveSignal!: () => void;
  const signal = new Promise<void>((resolve) => {
    resolveSignal = resolve;
  });
  const stop = () => resolveSignal();
  let terminal = false;
  let unsubscribe = () => {};
  const terminalFailure = new Promise<never>((_resolve, reject) => {
    unsubscribe = composition.subscribeStatus((status) => {
      if (status.state === "auth-failed") {
        terminal = true;
        unsubscribe();
        reject(new Error("agent_host_auth_failed"));
      } else if (status.state === "degraded") {
        terminal = true;
        unsubscribe();
        reject(new Error("agent_host_transport_degraded"));
      }
    });
    if (terminal) unsubscribe();
  });
  processLike.once("SIGINT", stop);
  processLike.once("SIGTERM", stop);
  try {
    await composition.start();
    await Promise.race([signal, terminalFailure]);
  } finally {
    unsubscribe();
    processLike.off("SIGINT", stop);
    processLike.off("SIGTERM", stop);
    await composition.shutdown();
  }
}

export async function runAgentHostCli(
  argv: readonly string[],
  options: {
    operator?: AgentHostOperatorService;
    io?: AgentHostCliIo;
    processLike?: Pick<NodeJS.Process, "once" | "off">;
  } = {}
): Promise<number> {
  const io = options.io ?? { stdout: console.log, stderr: console.error };
  try {
    const parsed = parseAgentHostArgs(argv);
    const operator = options.operator ?? new AgentHostOperator();
    if (parsed.command === "run") {
      await waitForAgentHostSignal(
        await operator.createDaemon(parsed.configPath),
        options.processLike ?? process
      );
      return 0;
    }
    const result =
      parsed.command === "enroll"
        ? await operator.enroll(parsed.configPath, parsed.code ?? "", parsed.replace)
        : parsed.command === "revoke"
          ? await operator.revoke(parsed.configPath)
          : parsed.command === "preflight"
            ? await operator.preflight(parsed.configPath)
            : await operator.status(parsed.configPath);
    io.stdout(JSON.stringify(result));
    return 0;
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":", 1)[0] : "agent_host_failed";
    io.stderr(code.startsWith("agent_host_") ? code : "agent_host_failed");
    return code.startsWith("agent_host_cli_") ? 2 : 1;
  }
}
