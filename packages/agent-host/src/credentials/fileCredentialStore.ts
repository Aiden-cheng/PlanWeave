import { randomBytes } from "node:crypto";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  HostCredentialRotationResponse,
  HostEnrollmentCompleted
} from "@planweave-ai/agent-host-protocol";
import type { SetupCodeRedeemHostResponse } from "@planweave-ai/collaboration-protocol/setup";
import {
  hostCredentialDocumentSchema,
  type ActiveHostCredential,
  type HostCredentialDocument,
  type PendingHostCredentialRotation,
  type PendingHostEnrollment
} from "./credentialContract.js";
import {
  consumePortableHandoffProvenance,
  rotatePortableHandoffProvenance
} from "./handoffProvenance.js";
import {
  createPrivateStorageSecurity,
  type PrivateStorageSecurityPort
} from "../storage/privateStorageSecurity.js";

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function secureMetadata(
  path: string,
  kind: "directory" | "file",
  permissionModel: PrivateStorageSecurityPort["permissionModel"]
): Promise<void> {
  const metadata = await lstat(path);
  if (
    (kind === "directory" && !metadata.isDirectory()) ||
    (kind === "file" && !metadata.isFile())
  ) {
    throw new Error("agent_host_credential_path_unsafe");
  }
  const expected = kind === "directory" ? 0o700 : 0o600;
  if (permissionModel === "posix" && (metadata.mode & 0o777) !== expected)
    throw new Error("agent_host_credential_permissions_unsafe");
  if (permissionModel === "posix" && process.getuid && metadata.uid !== process.getuid()) {
    throw new Error("agent_host_credential_owner_unsafe");
  }
}

async function syncParentDirectory(
  path: string,
  permissionModel: PrivateStorageSecurityPort["permissionModel"]
): Promise<void> {
  if (permissionModel === "windows-acl") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class FileHostCredentialStore {
  constructor(
    readonly path: string,
    private readonly security: PrivateStorageSecurityPort = createPrivateStorageSecurity()
  ) {}

  async read(): Promise<HostCredentialDocument | null> {
    try {
      const directory = dirname(this.path);
      await secureMetadata(directory, "directory", this.security.permissionModel);
      await secureMetadata(this.path, "file", this.security.permissionModel);
      await this.security.prepareDirectory(directory);
      await this.security.secureFile(this.path);
      return hostCredentialDocumentSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async begin(
    pending: PendingHostEnrollment,
    replaceExisting: boolean,
    restartPendingEnrollment = false
  ): Promise<void> {
    const current = await this.read();
    if (current?.pending) {
      if (!restartPendingEnrollment) {
        throw new Error("agent_host_enrollment_already_pending");
      }
      if (
        current.active ||
        current.pending.kind !== "host_enrollment_code" ||
        !current.pending.provenance ||
        pending.kind !== "host_enrollment_code" ||
        !pending.provenance
      ) {
        throw new Error("agent_host_handoff_pending_conflict");
      }
    }
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
    if (
      current.pending.expectedCredentialExpiresAt !== undefined &&
      current.pending.expectedCredentialExpiresAt !== response.credentialExpiresAt
    ) {
      throw new Error("agent_host_enrollment_response_mismatch");
    }
    if (
      current.pending.expectedCredentialPolicy !== undefined &&
      JSON.stringify(current.pending.expectedCredentialPolicy) !==
        JSON.stringify(response.credentialPolicy)
    ) {
      throw new Error("agent_host_enrollment_response_mismatch");
    }
    const active: ActiveHostCredential = {
      hostId: response.hostId,
      workspaceId: response.workspaceId,
      credentialToken: current.pending.credentialToken,
      issuedAt: now.toISOString(),
      expiresAt: response.credentialExpiresAt,
      credentialPolicy: response.credentialPolicy,
      ...(current.pending.provenance
        ? {
            provenance: consumePortableHandoffProvenance(
              current.pending.provenance,
              {
                hostId: response.hostId,
                workspaceId: response.workspaceId,
                credentialToken: current.pending.credentialToken,
                issuedAt: now.toISOString(),
                expiresAt: response.credentialExpiresAt
              },
              now
            )
          }
        : {})
    };
    await this.write({ version: "agent-host-credentials/v1", active });
    return active;
  }

  async promoteSetup(
    response: SetupCodeRedeemHostResponse,
    now = new Date()
  ): Promise<ActiveHostCredential> {
    const current = await this.read();
    if (
      !current?.pending ||
      current.pending.kind !== "setup_code" ||
      current.pending.enrollmentAttemptId !== response.enrollmentAttemptId
    ) {
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

  async beginRotation(rotation: PendingHostCredentialRotation): Promise<void> {
    const current = await this.read();
    if (!current?.active?.credentialPolicy || current.active.revokedAt) {
      throw new Error("agent_host_credential_renewal_not_configured");
    }
    if (current.rotation) {
      if (
        current.rotation.rotationId !== rotation.rotationId ||
        current.rotation.credentialToken !== rotation.credentialToken
      ) {
        throw new Error("agent_host_credential_rotation_conflict");
      }
      return;
    }
    await this.write({ ...current, rotation });
  }

  async commitRotation(
    response: HostCredentialRotationResponse,
    now = new Date()
  ): Promise<ActiveHostCredential> {
    const current = await this.read();
    if (
      !current?.active?.credentialPolicy ||
      !current.rotation ||
      current.active.hostId !== response.hostId ||
      current.rotation.rotationId !== response.rotationId
    ) {
      throw new Error("agent_host_credential_rotation_response_mismatch");
    }
    if (Date.parse(response.credentialExpiresAt) <= now.getTime()) {
      throw new Error("agent_host_credential_rotation_response_expired");
    }
    const nextCredential: ActiveHostCredential = {
      hostId: current.active.hostId,
      workspaceId: current.active.workspaceId,
      credentialToken: current.rotation.credentialToken,
      issuedAt: now.toISOString(),
      expiresAt: response.credentialExpiresAt,
      credentialPolicy: current.active.credentialPolicy,
      ...(current.active.provenance
        ? {
            provenance: rotatePortableHandoffProvenance(
              current.active.provenance,
              {
                hostId: current.active.hostId,
                workspaceId: current.active.workspaceId,
                credentialToken: current.rotation.credentialToken,
                issuedAt: now.toISOString(),
                expiresAt: response.credentialExpiresAt
              },
              now
            )
          }
        : {})
    };
    await this.write({ version: "agent-host-credentials/v1", active: nextCredential });
    return nextCredential;
  }

  async markRevoked(revokedAt = new Date()): Promise<void> {
    const current = await this.read();
    if (!current?.active) throw new Error("agent_host_credential_unavailable");
    await this.write({
      version: "agent-host-credentials/v1",
      active: { ...current.active, revokedAt: revokedAt.toISOString() },
      pending: current.pending,
      rotation: current.rotation
    });
  }

  private async write(document: HostCredentialDocument): Promise<void> {
    const parsed = hostCredentialDocumentSchema.parse(document);
    const directory = dirname(this.path);
    await this.security.prepareDirectory(directory);
    await secureMetadata(directory, "directory", this.security.permissionModel);
    try {
      await secureMetadata(this.path, "file", this.security.permissionModel);
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
      await this.security.secureFile(this.path);
      await secureMetadata(this.path, "file", this.security.permissionModel);
      await syncParentDirectory(directory, this.security.permissionModel);
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
