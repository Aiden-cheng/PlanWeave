#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadServerConfig, resolveServerConfigPath, serverConfigSummary } from "./config.js";
import { serveDistributedServer, type DistributedServerProcess } from "./serverServe.js";
import { runVpsE2eCli } from "./vpsE2e/cli.js";

export type ServerCliIo = { stdout(value: string): void; stderr(value: string): void };

export async function waitForServerSignal(
  server: Pick<DistributedServerProcess, "close">,
  processLike: Pick<NodeJS.Process, "once" | "off">
): Promise<void> {
  let resolveSignal!: () => void;
  const signal = new Promise<void>((resolve) => {
    resolveSignal = resolve;
  });
  const stop = () => resolveSignal();
  processLike.once("SIGINT", stop);
  processLike.once("SIGTERM", stop);
  try {
    await signal;
  } finally {
    processLike.off("SIGINT", stop);
    processLike.off("SIGTERM", stop);
    await server.close();
  }
}

export async function runServerCli(
  argv: readonly string[],
  options: {
    env?: Readonly<Record<string, string | undefined>>;
    io?: ServerCliIo;
    processLike?: Pick<NodeJS.Process, "once" | "off">;
    serve?: typeof serveDistributedServer;
  } = {}
): Promise<number> {
  const io = options.io ?? { stdout: console.log, stderr: console.error };
  try {
    const [command, ...args] = argv;
    if (command === "vps-e2e") {
      return await runVpsE2eCli(args, { io, env: options.env ? { ...options.env } : undefined });
    }
    if (command !== "serve") throw new Error("server_cli_usage");
    const config = await loadServerConfig(resolveServerConfigPath(args, options.env));
    const server = await (options.serve ?? serveDistributedServer)(config);
    io.stdout(
      JSON.stringify({
        ...serverConfigSummary(config),
        status: "ready",
        serverVersion: server.version
      })
    );
    await waitForServerSignal(server, options.processLike ?? process);
    return 0;
  } catch (error) {
    const code = error instanceof Error ? error.message.split(":", 1)[0] : "server_failed";
    io.stderr(code.startsWith("server_") ? code : "server_failed");
    return code === "server_cli_usage" || code === "server_config_path_required" ? 2 : 1;
  }
}

export function isServerCliEntrypoint(moduleUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isServerCliEntrypoint(import.meta.url, process.argv[1])) {
  process.exitCode = await runServerCli(process.argv.slice(2));
}
