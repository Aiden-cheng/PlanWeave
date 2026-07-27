import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { HostEnrollmentCompleted } from "@planweave-ai/distributed-protocol";
import {
  hostCredentialDocumentSchema,
  type ActiveHostCredential,
  type HostCredentialDocument,
  type PendingHostEnrollment
} from "./credentialContract.js";

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function secureMetadata(path: string, kind: "directory" | "file"): Promise<void> {
  const metadata = await lstat(path);
  if (
    (kind === "directory" && !metadata.isDirectory()) ||
    (kind === "file" && !metadata.isFile())
  ) {
    throw new Error("agent_host_credential_path_unsafe");
  }
  const expected = kind === "directory" ? 0o700 : 0o600;
  if ((metadata.mode & 0o777) !== expected)
    throw new Error("agent_host_credential_permissions_unsafe");
  if (process.platform !== "win32" && process.getuid && metadata.uid !== process.getuid()) {
    throw new Error("agent_host_credential_owner_unsafe");
  }
}

export class FileHostCredentialStore {
  constructor(readonly path: string) {}

  async read(): Promise<HostCredentialDocument | null> {
    try {
      await secureMetadata(dirname(this.path), "directory");
      await secureMetadata(this.path, "file");
      return hostCredentialDocumentSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async begin(pending: PendingHostEnrollment, replaceExisting: boolean): Promise<void> {
    const current = await this.read();
    if (current?.pending) throw new Error("agent_host_enrollment_already_pending");
    if (current?.active && !replaceExisting)
      throw new Error("agent_host_credential_replacement_requires_operator");
    await this.write({ version: "agent-host-credentials/v1", active: current?.active, pending });
  }

  async promote(
    response: HostEnrollmentCompleted,
    now = new Date()
  ): Promise<ActiveHostCredential> {
    const current = await this.read();
    if (
      !current?.pending ||
      current.pending.kind !== "host_enrollment_code" ||
      current.pending.enrollmentAttemptId !== response.enrollmentAttemptId
    ) {
      throw new Error("agent_host_enrollment_response_mismatch");
    }
    if (Date.parse(response.credentialExpiresAt) <= now.getTime()) {
      throw new Error("agent_host_enrollment_response_expired");
    }
    const active = {
      hostId: response.hostId,
      workspaceId: response.workspaceId,
      credentialToken: current.pending.credentialToken,
      issuedAt: now.toISOString(),
      expiresAt: response.credentialExpiresAt
    };
    await this.write({ version: "agent-host-credentials/v1", active });
    return active;
  }

  async promoteSetup(
    response: { hostId: string; workspaceId: string; hostCredentialExpiresAt: string },
    now = new Date()
  ): Promise<ActiveHostCredential> {
    const current = await this.read();
    if (!current?.pending || current.pending.kind !== "setup_code") {
      throw new Error("agent_host_enrollment_response_mismatch");
    }
    if (Date.parse(response.hostCredentialExpiresAt) <= now.getTime()) {
      throw new Error("agent_host_enrollment_response_expired");
    }
    const active = {
      hostId: response.hostId,
      workspaceId: response.workspaceId,
      credentialToken: current.pending.credentialToken,
      issuedAt: now.toISOString(),
      expiresAt: response.hostCredentialExpiresAt
    };
    await this.write({ version: "agent-host-credentials/v1", active });
    return active;
  }

  async requireUsable(now = new Date()): Promise<ActiveHostCredential> {
    const active = (await this.read())?.active;
    if (!active || active.revokedAt || Date.parse(active.expiresAt) <= now.getTime()) {
      throw new Error("agent_host_credential_unavailable");
    }
    return active;
  }

  async markRevoked(revokedAt = new Date()): Promise<void> {
    const current = await this.read();
    if (!current?.active) throw new Error("agent_host_credential_unavailable");
    await this.write({
      version: "agent-host-credentials/v1",
      active: { ...current.active, revokedAt: revokedAt.toISOString() },
      pending: current.pending
    });
  }

  private async write(document: HostCredentialDocument): Promise<void> {
    const parsed = hostCredentialDocumentSchema.parse(document);
    const directory = dirname(this.path);
    try {
      await secureMetadata(directory, "directory");
    } catch (error) {
      if (!missing(error)) throw error;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await secureMetadata(directory, "directory");
    }
    try {
      await secureMetadata(this.path, "file");
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const temporary = `${this.path}.${randomBytes(12).toString("hex")}.tmp`;
    let renamed = false;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
      renamed = true;
      await secureMetadata(this.path, "file");
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      if (renamed) {
        throw new Error("agent_host_credential_commit_durability_failed", { cause: error });
      }
      try {
        await unlink(temporary);
      } catch (cleanupError) {
        if (!missing(cleanupError)) {
          throw new AggregateError(
            [error, cleanupError],
            "agent_host_credential_write_and_cleanup_failed"
          );
        }
      }
      throw error;
    }
  }
}
