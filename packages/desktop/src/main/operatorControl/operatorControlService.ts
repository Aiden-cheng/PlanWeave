import {
  assertNoSmuggledOperatorSecrets,
  operatorControlProfileSchema,
  operatorCreateEnrollmentGrantInputSchema,
  operatorImportCredentialInputSchema,
  operatorListHostsInputSchema,
  operatorProfileIdInputSchema,
  operatorRevokeHostInputSchema,
  OperatorControlError,
  type OperatorControlProfile,
  type OperatorControlStatus,
  type OperatorCredentialPersistence,
  type OperatorProfileView
} from "../../shared/operatorControl.js";
import {
  OperatorControlClient,
  type OperatorControlClientOptions
} from "./OperatorControlClient.js";
import {
  operatorCredentialVaultPaths,
  OperatorCredentialVault,
  type OperatorCredentialVaultOptions,
  type OperatorSafeStoragePort
} from "./operatorCredentialVault.js";
import {
  operatorProfileStorePaths,
  OperatorProfileStore,
  type OperatorProfileStorePaths
} from "./operatorProfileStore.js";

export const OPERATOR_SESSION_ONLY_WARNING =
  "Operator credential is held for this session only because OS secure storage is unavailable.";

export type OperatorControlClientFactory = (
  options: OperatorControlClientOptions
) => OperatorControlClient;

export type OperatorControlServiceOptions = {
  profileStore?: OperatorProfileStore;
  vault?: OperatorCredentialVault;
  safeStorage?: OperatorSafeStoragePort;
  profileStorePaths?: OperatorProfileStorePaths;
  credentialsPath?: string;
  createClient?: OperatorControlClientFactory;
  request?: typeof fetch;
  clock?: { now(): Date };
  onStatusChange?: (status: OperatorControlStatus) => void;
};

function nowIso(clock?: { now(): Date }): string {
  return (clock?.now() ?? new Date()).toISOString();
}

function toPublicProfile(
  profile: OperatorControlProfile & { updatedAt: string },
  credential: {
    hasOperatorCredential: boolean;
    operatorCredentialPersistence: OperatorCredentialPersistence;
    operatorId: string | null;
  }
): OperatorProfileView {
  return {
    profileId: profile.profileId,
    displayName: profile.displayName,
    serverBaseUrl: profile.serverBaseUrl,
    allowInsecureTransport: profile.allowInsecureTransport,
    operatorId: credential.operatorId ?? profile.operatorId ?? null,
    hasOperatorCredential: credential.hasOperatorCredential,
    operatorCredentialPersistence: credential.operatorCredentialPersistence,
    updatedAt: profile.updatedAt
  };
}

/** Electron-main orchestration for isolated operator profiles and Host control calls. */
export class OperatorControlService {
  private readonly profiles: OperatorProfileStore;
  private readonly vault: OperatorCredentialVault;
  private readonly createClient: OperatorControlClientFactory;
  private readonly request?: typeof fetch;
  private readonly clock?: { now(): Date };
  private readonly onStatusChange?: (status: OperatorControlStatus) => void;
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private lastErrorCode: string | null = null;
  private lastErrorMessage: string | null = null;

  constructor(options: OperatorControlServiceOptions = {}) {
    this.profiles =
      options.profileStore ??
      new OperatorProfileStore(options.profileStorePaths ?? operatorProfileStorePaths());
    const vaultOptions: OperatorCredentialVaultOptions = {
      safeStorage: options.safeStorage,
      ...(options.credentialsPath
        ? { paths: operatorCredentialVaultPaths(options.credentialsPath) }
        : {})
    };
    this.vault = options.vault ?? new OperatorCredentialVault(vaultOptions);
    this.createClient =
      options.createClient ?? ((clientOptions) => new OperatorControlClient(clientOptions));
    this.request = options.request;
    this.clock = options.clock;
    this.onStatusChange = options.onStatusChange;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(operation);
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private assertOpen(): void {
    if (this.disposed)
      throw new OperatorControlError({ kind: "offline", code: "operator_service_closed" });
  }

  private async buildStatus(): Promise<OperatorControlStatus> {
    const profiles = await this.profiles.list();
    const views: OperatorProfileView[] = [];
    for (const profile of profiles) {
      const persistence = await this.vault.persistenceFor(profile.profileId);
      const metadata = await this.vault.getMetadata(profile.profileId);
      views.push(
        toPublicProfile(profile, {
          hasOperatorCredential: persistence !== "missing",
          operatorCredentialPersistence: persistence,
          operatorId: metadata?.operatorId ?? null
        })
      );
    }
    const sessionOnly =
      views.some((profile) => profile.operatorCredentialPersistence === "session-only") ||
      (await this.vault.hasAnySessionOnlyCredential());
    return {
      profiles: views,
      activeProfileId: await this.profiles.getActiveProfileId(),
      credentialStorage: this.vault.storageAvailability(),
      nonPersistenceWarning: sessionOnly ? OPERATOR_SESSION_ONLY_WARNING : null,
      lastErrorCode: this.lastErrorCode,
      lastErrorMessage: this.lastErrorMessage,
      updatedAt: nowIso(this.clock)
    };
  }

  private async publishStatus(): Promise<OperatorControlStatus> {
    const status = await this.buildStatus();
    this.onStatusChange?.(status);
    return status;
  }

  private rememberError(error: unknown): void {
    if (error instanceof OperatorControlError) {
      this.lastErrorCode = error.code;
      this.lastErrorMessage = error.message;
    } else {
      this.lastErrorCode = "operator_request_failed";
      this.lastErrorMessage = "Operator request failed.";
    }
  }

  async getStatus(): Promise<OperatorControlStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      return this.buildStatus();
    });
  }

  async upsertProfile(input: unknown): Promise<OperatorControlStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      assertNoSmuggledOperatorSecrets(input, "upsertOperatorProfile");
      const profile = operatorControlProfileSchema.parse(input);
      await this.profiles.upsert(profile);
      return this.publishStatus();
    });
  }

  async removeProfile(input: unknown): Promise<OperatorControlStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      assertNoSmuggledOperatorSecrets(input, "removeOperatorProfile");
      const { profileId } = operatorProfileIdInputSchema.parse(input);
      await this.vault.clear(profileId);
      await this.profiles.remove(profileId);
      return this.publishStatus();
    });
  }

  async setActiveProfile(input: unknown): Promise<OperatorControlStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      assertNoSmuggledOperatorSecrets(input, "setActiveOperatorProfile");
      const { profileId } = operatorProfileIdInputSchema.parse(input);
      await this.profiles.setActiveProfileId(profileId);
      return this.publishStatus();
    });
  }

  async clearActiveProfile(): Promise<OperatorControlStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.profiles.setActiveProfileId(null);
      return this.publishStatus();
    });
  }

  async importCredential(input: unknown): Promise<OperatorControlStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      if (!input || typeof input !== "object") {
        throw new OperatorControlError({ kind: "validation", code: "operator_import_invalid" });
      }
      const raw = input as Record<string, unknown>;
      for (const key of [
        "encryptedOperatorToken",
        "authorization",
        "Authorization",
        "credentialPath",
        "credentialsPath",
        "headers",
        "url",
        "path",
        "command"
      ]) {
        if (key in raw && raw[key] !== undefined) {
          throw new OperatorControlError({
            kind: "validation",
            code: "operator_ipc_payload_forbidden",
            message: `Operator IPC rejected importCredential: field "${key}" is not allowed.`
          });
        }
      }
      const parsed = operatorImportCredentialInputSchema.parse(input);
      if (!(await this.profiles.get(parsed.profileId))) {
        throw new OperatorControlError({ kind: "validation", code: "operator_profile_not_found" });
      }
      await this.vault.setOperatorToken(parsed.profileId, parsed.operatorToken, parsed.operatorId);
      return this.publishStatus();
    });
  }

  async clearCredential(input: unknown): Promise<OperatorControlStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      assertNoSmuggledOperatorSecrets(input, "clearOperatorCredential");
      const { profileId } = operatorProfileIdInputSchema.parse(input);
      await this.vault.clear(profileId);
      return this.publishStatus();
    });
  }

  async listHosts(
    input: unknown
  ): Promise<Awaited<ReturnType<OperatorControlClient["listHosts"]>>> {
    assertNoSmuggledOperatorSecrets(input, "listHosts");
    const parsed = operatorListHostsInputSchema.parse(input);
    return this.enqueue(() =>
      this.withProfile(parsed, (client, value) => client.listHosts(value.query ?? {}))
    );
  }

  async createEnrollmentGrant(
    input: unknown
  ): Promise<Awaited<ReturnType<OperatorControlClient["createEnrollmentGrant"]>>> {
    assertNoSmuggledOperatorSecrets(input, "createEnrollmentGrant");
    const parsed = operatorCreateEnrollmentGrantInputSchema.parse(input);
    return this.enqueue(() =>
      this.withProfile(parsed, (client, value) => client.createEnrollmentGrant(value.request))
    );
  }

  async revokeHost(
    input: unknown
  ): Promise<Awaited<ReturnType<OperatorControlClient["revokeHost"]>>> {
    assertNoSmuggledOperatorSecrets(input, "revokeHost");
    const parsed = operatorRevokeHostInputSchema.parse(input);
    return this.enqueue(() =>
      this.withProfile(parsed, (client, value) => client.revokeHost(value.hostId))
    );
  }

  private async withProfile<T, P extends { profileId: string }>(
    parsed: P,
    action: (client: OperatorControlClient, parsed: P) => Promise<T>
  ): Promise<T> {
    this.assertOpen();
    const profile = await this.profiles.get(parsed.profileId);
    if (!profile)
      throw new OperatorControlError({ kind: "validation", code: "operator_profile_not_found" });
    const token = await this.vault.getOperatorToken(parsed.profileId);
    if (!token)
      throw new OperatorControlError({ kind: "unauthorized", code: "operator_credential_missing" });
    const client = this.createClient({
      profile: operatorControlProfileSchema.parse({
        profileId: profile.profileId,
        displayName: profile.displayName,
        serverBaseUrl: profile.serverBaseUrl,
        allowInsecureTransport: profile.allowInsecureTransport,
        ...(profile.operatorId ? { operatorId: profile.operatorId } : {})
      }),
      credential: { getOperatorToken: () => this.vault.getOperatorToken(parsed.profileId) },
      request: this.request
    });
    try {
      const result = await action(client, parsed);
      this.lastErrorCode = null;
      this.lastErrorMessage = null;
      return result;
    } catch (error) {
      this.rememberError(error);
      throw error;
    } finally {
      client.dispose();
    }
  }

  async shutdown(): Promise<void> {
    await this.enqueue(async () => {
      this.vault.clearSessionMemory();
      this.disposed = true;
    });
  }
}
