import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createPrivateStorageSecurity,
  type PrivateStorageSecurityPort
} from "../storage/privateStorageSecurity.js";

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function replacePrivateFile(temporaryPath: string, path: string): Promise<void> {
  if (process.platform !== "win32") {
    await rename(temporaryPath, path);
    return;
  }
  // Windows rename can fail transiently (AV/indexer locks) or need an unlink-first replace.
  let lastError: unknown;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await rename(temporaryPath, path);
      return;
    } catch (error) {
      lastError = error;
      const code = errorCode(error);
      if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY" && code !== "EEXIST") {
        throw error;
      }
      try {
        await unlink(path);
      } catch (unlinkError) {
        if (errorCode(unlinkError) !== "ENOENT") {
          // Keep retrying on transient destination locks.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function writePrivateTextFile(
  path: string,
  value: string,
  security: PrivateStorageSecurityPort = createPrivateStorageSecurity()
): Promise<void> {
  await security.prepareDirectory(dirname(path));
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, value, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    await replacePrivateFile(temporaryPath, path);
    await security.secureFile(path);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if (errorCode(cleanupError) !== "ENOENT") {
        throw new AggregateError([error, cleanupError], "agent_host_config_cleanup_failed");
      }
    }
    throw error;
  }
}

export async function writePrivateJsonFile(
  path: string,
  value: unknown,
  security?: PrivateStorageSecurityPort
): Promise<void> {
  await writePrivateTextFile(path, `${JSON.stringify(value, null, 2)}\n`, security);
}
