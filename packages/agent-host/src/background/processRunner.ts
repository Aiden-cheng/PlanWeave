import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type FixedArgvRunner = (
  executable: string,
  args: readonly string[]
) => Promise<{ stdout: string; stderr: string }>;

export const runFixedArgv: FixedArgvRunner = async (executable, args) =>
  execFileAsync(executable, [...args], { encoding: "utf8", windowsHide: true });
