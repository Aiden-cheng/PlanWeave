import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createPrivateStorageSecurity,
  type PrivateStorageSecurityPort
} from "../storage/privateStorageSecurity.js";

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
    await rename(temporaryPath, path);
    await security.secureFile(path);
  } catch (error) {
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if (
        !(
          cleanupError &&
          typeof cleanupError === "object" &&
          "code" in cleanupError &&
          cleanupError.code === "ENOENT"
        )
      ) {
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
