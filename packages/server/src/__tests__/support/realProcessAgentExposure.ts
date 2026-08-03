import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type HostCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export async function createAgentExecutableProbe(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  if (process.platform === "win32") {
    await writeFile(join(directory, "codex-acp.cmd"), "@exit /b 0\r\n", { mode: 0o755 });
    return;
  }
  await writeFile(join(directory, "codex-acp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

function controlledEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const overriddenKeys = new Set(Object.keys(overrides).map((key) => key.toLowerCase()));
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !overriddenKeys.has(key.toLowerCase()))
    ),
    ...overrides
  };
}

export function runAgentHostCommand(
  binPath: string,
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = {}
): Promise<HostCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...argv], {
      stdio: ["ignore", "pipe", "pipe"],
      env: controlledEnvironment(environment)
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
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
