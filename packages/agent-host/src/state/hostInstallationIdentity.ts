import { randomUUID } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { hostInstallationIdSchema } from "@planweave-ai/agent-host-protocol";
import { z } from "zod";
import {
  createPrivateStorageSecurity,
  type PrivateStorageSecurityPort
} from "../storage/privateStorageSecurity.js";

const hostInstallationIdentitySchema = z
  .object({
    version: z.literal("agent-host-installation-identity/v1"),
    installationId: hostInstallationIdSchema
  })
  .strict();

const identityFileName = "installation.json";

function exists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function assertSecure(
  path: string,
  kind: "directory" | "file",
  permissionModel: PrivateStorageSecurityPort["permissionModel"]
): Promise<void> {
  const metadata = await lstat(path);
  if (
    (kind === "directory" && !metadata.isDirectory()) ||
    (kind === "file" && !metadata.isFile())
  ) {
    throw new Error("agent_host_installation_identity_path_unsafe");
  }
  const expectedMode = kind === "directory" ? 0o700 : 0o600;
  if (permissionModel === "posix" && (metadata.mode & 0o777) !== expectedMode) {
    throw new Error("agent_host_installation_identity_permissions_unsafe");
  }
  if (permissionModel === "posix" && process.getuid && metadata.uid !== process.getuid()) {
    throw new Error("agent_host_installation_identity_owner_unsafe");
  }
}

async function readIdentity(
  path: string,
  permissionModel: PrivateStorageSecurityPort["permissionModel"]
): Promise<string> {
  await assertSecure(path, "file", permissionModel);
  return hostInstallationIdentitySchema.parse(JSON.parse(await readFile(path, "utf8")))
    .installationId;
}

/** Create once and retain across credential replacement and durable execution-state cleanup. */
export async function ensureHostInstallationIdentity(
  dataDirectory: string,
  security: PrivateStorageSecurityPort = createPrivateStorageSecurity()
): Promise<string> {
  await security.prepareDirectory(dataDirectory);
  await assertSecure(dataDirectory, "directory", security.permissionModel);
  const path = join(dataDirectory, identityFileName);
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify({
          version: "agent-host-installation-identity/v1",
          installationId: randomUUID()
        })}\n`,
        "utf8"
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!exists(error)) throw error;
  }
  await security.secureFile(path);
  return readIdentity(path, security.permissionModel);
}
