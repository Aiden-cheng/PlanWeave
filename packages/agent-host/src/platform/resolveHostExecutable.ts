import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { resolveWindowsCommand } from "@planweave-ai/runtime";

export type ResolveHostExecutableOptions = {
  command: string;
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
};

function unavailablePathError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EACCES";
}

async function resolvePosixCandidate(candidate: string): Promise<string | null> {
  const resolved = await canonicalizeCandidate(candidate);
  if (!resolved) return null;
  try {
    await access(resolved, constants.X_OK);
    return resolved;
  } catch (error) {
    if (unavailablePathError(error)) return null;
    throw error;
  }
}

async function canonicalizeCandidate(candidate: string): Promise<string | null> {
  try {
    return await realpath(candidate);
  } catch (error) {
    if (unavailablePathError(error)) return null;
    throw error;
  }
}

export async function resolveHostExecutable(
  options: ResolveHostExecutableOptions
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform === "win32") {
    const resolved = resolveWindowsCommand({
      command: options.command,
      cwd: options.cwd,
      env: { ...env }
    });
    return resolved ? canonicalizeCandidate(resolved.executable) : null;
  }

  if (isAbsolute(options.command)) return resolvePosixCandidate(options.command);
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const resolved = await resolvePosixCandidate(join(directory, options.command));
    if (resolved) return resolved;
  }
  return null;
}
