import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { operatorTokenSchema } from "@planweave-ai/distributed-protocol";
import { z } from "zod";
import type {
  OperatorCredentialPersistence,
  OperatorCredentialStorage
} from "../../shared/operatorControl.js";
import { desktopHomePaths } from "../planweaveHomePaths.js";

export type OperatorSafeStoragePort = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

const persistedOperatorCredentialSchema = z
  .object({
    encryptedOperatorToken: z.string().trim().min(1),
    operatorId: z.string().trim().min(1).max(128).nullable(),
    updatedAt: z.iso.datetime()
  })
  .strict();

const operatorCredentialsDocumentSchema = z
  .object({
    version: z.literal(1),
    credentials: z.record(z.string().trim().min(1).max(128), persistedOperatorCredentialSchema)
  })
  .strict();

type OperatorCredentialsDocument = z.infer<typeof operatorCredentialsDocumentSchema>;
type SessionCredential = { operatorToken: string; operatorId: string | null; updatedAt: string };

export type OperatorCredentialVaultPaths = { credentialsPath: string };
export type StoredOperatorCredentialMetadata = {
  operatorId: string | null;
  updatedAt: string;
};

export function operatorCredentialVaultPaths(
  credentialsPath: string = desktopHomePaths().operatorCredentialsFile
): OperatorCredentialVaultPaths {
  return { credentialsPath };
}

export type OperatorCredentialVaultOptions = {
  paths?: OperatorCredentialVaultPaths;
  safeStorage?: OperatorSafeStoragePort;
};

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function defaultDocument(): OperatorCredentialsDocument {
  return { version: 1, credentials: {} };
}

async function ensurePrivateFileParent(path: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  });
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await ensurePrivateFileParent(path);
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporaryPath, path);
  const written = await stat(path);
  if ((written.mode & 0o777) !== 0o600) await chmod(path, 0o600);
}

/** Main-only operator bearer vault. Durable entries are safeStorage ciphertext, never plaintext. */
export class OperatorCredentialVault {
  private readonly safeStorage: OperatorSafeStoragePort;
  private readonly sessionCredentials = new Map<string, SessionCredential>();
  private document: OperatorCredentialsDocument | null = null;
  private loaded = false;

  constructor(options: OperatorCredentialVaultOptions = {}) {
    this.paths = options.paths ?? operatorCredentialVaultPaths();
    this.safeStorage = options.safeStorage ?? {
      isEncryptionAvailable: () => false,
      encryptString: () => {
        throw new Error("safeStorage is not configured");
      },
      decryptString: () => {
        throw new Error("safeStorage is not configured");
      }
    };
  }

  private readonly paths: OperatorCredentialVaultPaths;

  get credentialsPath(): string {
    return this.paths.credentialsPath;
  }

  storageAvailability(): OperatorCredentialStorage {
    return this.safeStorage.isEncryptionAvailable() ? "available" : "unavailable";
  }

  private encrypt(token: string): string {
    return this.safeStorage.encryptString(token).toString("base64");
  }

  private decrypt(value: string): string | null {
    if (!this.safeStorage.isEncryptionAvailable()) return null;
    try {
      const token = this.safeStorage.decryptString(Buffer.from(value, "base64"));
      return operatorTokenSchema.safeParse(token).success ? token : null;
    } catch {
      return null;
    }
  }

  private async load(): Promise<OperatorCredentialsDocument> {
    if (this.loaded && this.document) return this.document;
    let raw: string;
    try {
      raw = await readFile(this.paths.credentialsPath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        this.document = defaultDocument();
        this.loaded = true;
        return this.document;
      }
      throw new Error("Failed to read operator credentials.");
    }
    try {
      this.document = operatorCredentialsDocumentSchema.parse(JSON.parse(raw));
      this.loaded = true;
      return this.document;
    } catch {
      throw new Error("Invalid operator credentials JSON.");
    }
  }

  private async persist(document: OperatorCredentialsDocument): Promise<void> {
    const parsed = operatorCredentialsDocumentSchema.parse(document);
    await writePrivateJson(this.paths.credentialsPath, parsed);
    this.document = parsed;
    this.loaded = true;
  }

  async getOperatorToken(profileId: string): Promise<string | undefined> {
    const session = this.sessionCredentials.get(profileId);
    if (session) return session.operatorToken;
    if (!this.safeStorage.isEncryptionAvailable()) return undefined;
    const document = await this.load();
    const record = document.credentials[profileId];
    if (!record) return undefined;
    const token = this.decrypt(record.encryptedOperatorToken);
    if (!token) {
      delete document.credentials[profileId];
      await this.persist(document);
      return undefined;
    }
    this.sessionCredentials.set(profileId, {
      operatorToken: token,
      operatorId: record.operatorId,
      updatedAt: record.updatedAt
    });
    return token;
  }

  async getMetadata(profileId: string): Promise<StoredOperatorCredentialMetadata | null> {
    const session = this.sessionCredentials.get(profileId);
    if (session) return { operatorId: session.operatorId, updatedAt: session.updatedAt };
    if (!this.safeStorage.isEncryptionAvailable()) return null;
    const document = await this.load();
    const record = document.credentials[profileId];
    if (!record || !this.decrypt(record.encryptedOperatorToken)) return null;
    return { operatorId: record.operatorId, updatedAt: record.updatedAt };
  }

  async persistenceFor(profileId: string): Promise<OperatorCredentialPersistence> {
    const session = this.sessionCredentials.get(profileId);
    if (session) {
      if (this.safeStorage.isEncryptionAvailable()) {
        const document = await this.load();
        if (document.credentials[profileId]) return "persisted";
      }
      return "session-only";
    }
    if (!this.safeStorage.isEncryptionAvailable()) return "missing";
    const document = await this.load();
    const record = document.credentials[profileId];
    if (!record) return "missing";
    if (!this.decrypt(record.encryptedOperatorToken)) {
      delete document.credentials[profileId];
      await this.persist(document);
      return "missing";
    }
    return "persisted";
  }

  async hasCredential(profileId: string): Promise<boolean> {
    return (await this.persistenceFor(profileId)) !== "missing";
  }

  async setOperatorToken(
    profileId: string,
    rawToken: string,
    operatorId?: string | null
  ): Promise<OperatorCredentialPersistence> {
    const operatorToken = operatorTokenSchema.parse(rawToken);
    const normalizedOperatorId = operatorId?.trim() || null;
    const updatedAt = new Date().toISOString();
    this.sessionCredentials.set(profileId, {
      operatorToken,
      operatorId: normalizedOperatorId,
      updatedAt
    });
    if (!this.safeStorage.isEncryptionAvailable()) {
      const document = await this.load();
      if (document.credentials[profileId]) {
        delete document.credentials[profileId];
        await this.persist(document);
      }
      return "session-only";
    }
    const document = await this.load();
    document.credentials[profileId] = {
      encryptedOperatorToken: this.encrypt(operatorToken),
      operatorId: normalizedOperatorId,
      updatedAt
    };
    await this.persist(document);
    return "persisted";
  }

  async clear(profileId: string): Promise<void> {
    this.sessionCredentials.delete(profileId);
    const document = await this.load();
    if (document.credentials[profileId]) {
      delete document.credentials[profileId];
      await this.persist(document);
    }
  }

  async hasAnySessionOnlyCredential(): Promise<boolean> {
    return !this.safeStorage.isEncryptionAvailable() && this.sessionCredentials.size > 0;
  }

  clearSessionMemory(): void {
    this.sessionCredentials.clear();
  }
}
