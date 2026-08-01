import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  humanCreateInvitationResponseSchema,
  opaqueIdentifierSchema,
  type HumanCreateInvitationResponse
} from "@planweave-ai/collaboration-contracts";
import { z } from "zod";
import { desktopHomePaths } from "../planweaveHomePaths.js";
import type { CollaborationSafeStoragePort } from "./collaborationCredentialVault.js";

const recordSchema = z.object({ encryptedInvitation: z.string().trim().min(1) }).strict();
const documentSchema = z
  .object({
    version: z.literal(1),
    invitations: z.record(
      opaqueIdentifierSchema,
      z.record(opaqueIdentifierSchema, recordSchema)
    )
  })
  .strict();
type InvitationDocument = z.infer<typeof documentSchema>;

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporaryPath, path);
  if (((await stat(path)).mode & 0o777) !== 0o600) await chmod(path, 0o600);
}

/** Main-process-only encrypted storage for invitation bearer secrets. */
export class CollaborationInvitationVault {
  private document: InvitationDocument | null = null;
  private readonly session = new Map<string, HumanCreateInvitationResponse>();

  constructor(
    private readonly options: { path?: string; safeStorage: CollaborationSafeStoragePort }
  ) {}

  private get path(): string {
    return this.options.path ?? desktopHomePaths().collaborationInvitationsFile;
  }

  private key(profileId: string, invitationId: string): string {
    return `${profileId}\u0000${invitationId}`;
  }

  private async load(): Promise<InvitationDocument> {
    if (this.document) return this.document;
    try {
      this.document = documentSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (!isMissingFileError(error)) throw new Error("Invalid collaboration invitation vault.");
      this.document = { version: 1, invitations: {} };
    }
    return this.document;
  }

  private async persist(document: InvitationDocument): Promise<void> {
    const parsed = documentSchema.parse(document);
    await writePrivateJson(this.path, parsed);
    this.document = parsed;
  }

  async set(
    profileId: string,
    value: HumanCreateInvitationResponse
  ): Promise<"persisted" | "session-only"> {
    const invitation = humanCreateInvitationResponseSchema.parse(value);
    const invitationId = invitation.invitation.invitationId;
    this.session.set(this.key(profileId, invitationId), invitation);
    if (!this.options.safeStorage.isEncryptionAvailable()) return "session-only";
    const document = await this.load();
    const profileInvitations = (document.invitations[profileId] ??= {});
    profileInvitations[invitationId] = {
      encryptedInvitation: this.options.safeStorage
        .encryptString(JSON.stringify(invitation))
        .toString("base64")
    };
    await this.persist(document);
    return "persisted";
  }

  async get(profileId: string, invitationId: string): Promise<HumanCreateInvitationResponse | null> {
    const cached = this.session.get(this.key(profileId, invitationId));
    if (cached) {
      if (!this.isExpired(cached)) return cached;
      await this.delete(profileId, invitationId);
      return null;
    }
    if (!this.options.safeStorage.isEncryptionAvailable()) return null;
    const document = await this.load();
    const record = document.invitations[profileId]?.[invitationId];
    if (!record) return null;
    try {
      const invitation = humanCreateInvitationResponseSchema.parse(
        JSON.parse(
          this.options.safeStorage.decryptString(Buffer.from(record.encryptedInvitation, "base64"))
        )
      );
      if (invitation.invitation.invitationId !== invitationId || this.isExpired(invitation)) {
        await this.delete(profileId, invitationId);
        return null;
      }
      this.session.set(this.key(profileId, invitationId), invitation);
      return invitation;
    } catch {
      await this.delete(profileId, invitationId);
      return null;
    }
  }

  async delete(profileId: string, invitationId: string): Promise<void> {
    this.session.delete(this.key(profileId, invitationId));
    const document = await this.load();
    const profileInvitations = document.invitations[profileId];
    if (!profileInvitations?.[invitationId]) return;
    delete profileInvitations[invitationId];
    if (Object.keys(profileInvitations).length === 0) delete document.invitations[profileId];
    await this.persist(document);
  }

  async clearProfile(profileId: string): Promise<void> {
    for (const key of this.session.keys()) {
      if (key.startsWith(`${profileId}\u0000`)) this.session.delete(key);
    }
    const document = await this.load();
    if (!document.invitations[profileId]) return;
    delete document.invitations[profileId];
    await this.persist(document);
  }

  private isExpired(value: HumanCreateInvitationResponse): boolean {
    return Date.parse(value.invitation.expiresAt) <= Date.now();
  }
}
