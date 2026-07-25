import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { opaqueIdentifierSchema } from "@planweave-ai/distributed-protocol";
import { z } from "zod";

const durableHostIdentitySchema = z
  .object({
    version: z.literal("agent-host-durable-identity/v1"),
    hostId: opaqueIdentifierSchema
  })
  .strict();

const identityFileName = "durable-host.json";
const durableStoreNames = [identityFileName, "state.sqlite", "remote-execution.sqlite"] as const;
const legacyStoreNames = ["state.sqlite", "remote-execution.sqlite"] as const;

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function exists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function assertSecure(path: string, kind: "directory" | "file"): Promise<void> {
  const metadata = await lstat(path);
  if (
    (kind === "directory" && !metadata.isDirectory()) ||
    (kind === "file" && !metadata.isFile())
  ) {
    throw new Error("agent_host_durable_identity_path_unsafe");
  }
  const expectedMode = kind === "directory" ? 0o700 : 0o600;
  if ((metadata.mode & 0o777) !== expectedMode) {
    throw new Error("agent_host_durable_identity_permissions_unsafe");
  }
  if (process.platform !== "win32" && process.getuid && metadata.uid !== process.getuid()) {
    throw new Error("agent_host_durable_identity_owner_unsafe");
  }
}

async function readIdentity(path: string): Promise<z.infer<typeof durableHostIdentitySchema>> {
  await assertSecure(path, "file");
  return durableHostIdentitySchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

export async function ensureDurableHostIdentity(
  dataDirectory: string,
  hostId: string
): Promise<void> {
  const parsedHostId = opaqueIdentifierSchema.parse(hostId);
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await assertSecure(dataDirectory, "directory");
  const path = join(dataDirectory, identityFileName);
  if (!(await pathExists(path))) {
    for (const name of legacyStoreNames) {
      if (await pathExists(join(dataDirectory, name))) {
        throw new Error("agent_host_durable_identity_unbound");
      }
    }
  }
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify({
          version: "agent-host-durable-identity/v1",
          hostId: parsedHostId
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
  const identity = await readIdentity(path);
  if (identity.hostId !== parsedHostId) {
    throw new Error("agent_host_durable_identity_mismatch");
  }
}

export async function assertDurableStateReplacementSafe(dataDirectory: string): Promise<void> {
  for (const name of durableStoreNames) {
    try {
      await lstat(join(dataDirectory, name));
      throw new Error("agent_host_reenrollment_requires_durable_state_export");
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
}
