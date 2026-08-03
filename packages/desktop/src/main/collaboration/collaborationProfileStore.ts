import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  collaborationConnectionProfileSchema,
  legacyCollaborationConnectionProfileSchema,
  type CollaborationConnectionProfile
} from "@planweave-ai/collaboration-protocol/connection";
import {
  opaqueIdentifierSchema,
  timestampSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import { z } from "zod";
import { desktopHomePaths } from "../planweaveHomePaths.js";
import { migrateLegacyStoredCollaborationProfile } from "./collaborationProfileEndpoint.js";

const storedCollaborationProfileSchema = collaborationConnectionProfileSchema
  .extend({
    updatedAt: timestampSchema,
    connectionState: z.literal("ready")
  })
  .strict();

const reconnectRequiredCollaborationProfileSchema = legacyCollaborationConnectionProfileSchema
  .extend({
    updatedAt: timestampSchema,
    connectionState: z.literal("reconnect_required"),
    endpoint: z.null()
  })
  .strict();

const storedCollaborationProfileRecordSchema = z.discriminatedUnion("connectionState", [
  storedCollaborationProfileSchema,
  reconnectRequiredCollaborationProfileSchema
]);

const currentCollaborationProfilesDocumentSchema = z
  .object({
    version: z.literal(3),
    profiles: z.array(storedCollaborationProfileRecordSchema),
    activeProfileId: opaqueIdentifierSchema.nullable()
  })
  .strict()
  .superRefine((document, ctx) => {
    const seen = new Set<string>();
    for (const [index, profile] of document.profiles.entries()) {
      if (seen.has(profile.profileId)) {
        ctx.addIssue({
          code: "custom",
          message: "duplicate collaboration profile id",
          path: ["profiles", index, "profileId"]
        });
      }
      seen.add(profile.profileId);
    }
    if (
      document.activeProfileId !== null &&
      !document.profiles.some(
        (profile) =>
          profile.profileId === document.activeProfileId && profile.connectionState === "ready"
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "active collaboration profile is missing",
        path: ["activeProfileId"]
      });
    }
  });

const versionTwoCollaborationProfilesDocumentSchema = z
  .object({
    version: z.literal(2),
    profiles: z.array(
      collaborationConnectionProfileSchema.extend({ updatedAt: timestampSchema }).strict()
    ),
    activeProfileId: opaqueIdentifierSchema.nullable()
  })
  .strict();

const legacyCollaborationProfilesDocumentSchema = z
  .object({
    version: z.literal(1),
    profiles: z.array(
      legacyCollaborationConnectionProfileSchema.extend({ updatedAt: timestampSchema })
    ),
    activeProfileId: opaqueIdentifierSchema.nullable()
  })
  .strict();

export type StoredCollaborationProfile = z.infer<typeof storedCollaborationProfileSchema>;
export type ReconnectRequiredCollaborationProfile = z.infer<
  typeof reconnectRequiredCollaborationProfileSchema
>;
export type StoredCollaborationProfileRecord = z.infer<
  typeof storedCollaborationProfileRecordSchema
>;
export type CollaborationProfilesDocument = z.infer<
  typeof currentCollaborationProfilesDocumentSchema
>;

function defaultDocument(): CollaborationProfilesDocument {
  return {
    version: 3,
    profiles: [],
    activeProfileId: null
  };
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseProfilesDocument(input: unknown): {
  document: CollaborationProfilesDocument;
  requiresWrite: boolean;
} {
  const current = currentCollaborationProfilesDocumentSchema.safeParse(input);
  if (current.success) {
    return { document: current.data, requiresWrite: false };
  }

  const versionTwo = versionTwoCollaborationProfilesDocumentSchema.safeParse(input);
  if (versionTwo.success) {
    return {
      document: currentCollaborationProfilesDocumentSchema.parse({
        version: 3,
        activeProfileId: versionTwo.data.activeProfileId,
        profiles: versionTwo.data.profiles.map((profile) => ({
          ...profile,
          connectionState: "ready"
        }))
      }),
      requiresWrite: true
    };
  }

  const legacy = legacyCollaborationProfilesDocumentSchema.parse(input);
  const profiles: StoredCollaborationProfileRecord[] = legacy.profiles.map(
    ({ updatedAt, ...profile }) => {
      try {
        return storedCollaborationProfileSchema.parse({
          ...migrateLegacyStoredCollaborationProfile(profile),
          updatedAt,
          connectionState: "ready"
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "collaboration_profile_endpoint_reconnect_required"
        ) {
          return reconnectRequiredCollaborationProfileSchema.parse({
            ...profile,
            updatedAt,
            connectionState: "reconnect_required",
            endpoint: null
          });
        }
        throw error;
      }
    }
  );
  return {
    document: currentCollaborationProfilesDocumentSchema.parse({
      version: 3,
      activeProfileId: profiles.some(
        (profile) =>
          profile.profileId === legacy.activeProfileId && profile.connectionState === "ready"
      )
        ? legacy.activeProfileId
        : null,
      profiles
    }),
    requiresWrite: true
  };
}

export type CollaborationProfileStorePaths = {
  profilesPath: string;
};

export function collaborationProfileStorePaths(
  profilesPath: string = desktopHomePaths().collaborationProfilesFile
): CollaborationProfileStorePaths {
  return { profilesPath };
}

async function ensurePrivateFileParent(path: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") {
      throw error;
    }
  });
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await ensurePrivateFileParent(path);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const written = await stat(tmp);
  if ((written.mode & 0o777) !== 0o600) {
    await chmod(tmp, 0o600);
  }
  await rename(tmp, path);
}

export type CollaborationProfileStorePersistence = {
  read(path: string): Promise<string>;
  write(path: string, value: unknown): Promise<void>;
};

const defaultPersistence: CollaborationProfileStorePersistence = {
  read: (path) => readFile(path, "utf8"),
  write: writePrivateJson
};

export class CollaborationProfileStore {
  private readonly paths: CollaborationProfileStorePaths;
  private readonly persistence: CollaborationProfileStorePersistence;
  private loaded: CollaborationProfilesDocument | null = null;

  constructor(
    paths: CollaborationProfileStorePaths = collaborationProfileStorePaths(),
    persistence: CollaborationProfileStorePersistence = defaultPersistence
  ) {
    this.paths = paths;
    this.persistence = persistence;
  }

  get profilesPath(): string {
    return this.paths.profilesPath;
  }

  async read(): Promise<CollaborationProfilesDocument> {
    if (this.loaded) {
      return currentCollaborationProfilesDocumentSchema.parse(this.loaded);
    }
    let raw: string;
    try {
      raw = await this.persistence.read(this.paths.profilesPath);
    } catch (error) {
      if (isMissingFileError(error)) {
        this.loaded = defaultDocument();
        return currentCollaborationProfilesDocumentSchema.parse(this.loaded);
      }
      throw new Error("Failed to read collaboration profiles.");
    }
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      throw new Error("Invalid collaboration profiles JSON.");
    }
    let parsed: ReturnType<typeof parseProfilesDocument>;
    try {
      parsed = parseProfilesDocument(input);
    } catch {
      throw new Error("Invalid collaboration profiles JSON.");
    }
    if (parsed.requiresWrite) {
      await this.persist(parsed.document);
    }
    this.loaded = parsed.document;
    return currentCollaborationProfilesDocumentSchema.parse(this.loaded);
  }

  private async persist(document: CollaborationProfilesDocument): Promise<void> {
    try {
      await this.persistence.write(this.paths.profilesPath, document);
    } catch {
      throw new Error("Failed to write collaboration profiles.");
    }
  }

  async write(document: CollaborationProfilesDocument): Promise<CollaborationProfilesDocument> {
    const parsed = currentCollaborationProfilesDocumentSchema.parse(document);
    await this.persist(parsed);
    this.loaded = parsed;
    return currentCollaborationProfilesDocumentSchema.parse(parsed);
  }

  async list(): Promise<StoredCollaborationProfileRecord[]> {
    const document = await this.read();
    return [...document.profiles];
  }

  async get(profileId: string): Promise<StoredCollaborationProfile | null> {
    const document = await this.read();
    const profile = document.profiles.find((entry) => entry.profileId === profileId);
    return profile?.connectionState === "ready" ? profile : null;
  }

  async upsert(profile: CollaborationConnectionProfile): Promise<StoredCollaborationProfile> {
    const document = await this.read();
    const stored: StoredCollaborationProfile = {
      ...collaborationConnectionProfileSchema.parse(profile),
      updatedAt: nowIso(),
      connectionState: "ready"
    };
    const index = document.profiles.findIndex((entry) => entry.profileId === stored.profileId);
    const profiles = [...document.profiles];
    if (index >= 0) {
      profiles[index] = stored;
    } else {
      profiles.push(stored);
    }
    await this.write({ ...document, profiles });
    return stored;
  }

  async remove(profileId: string): Promise<boolean> {
    const document = await this.read();
    const next = document.profiles.filter((profile) => profile.profileId !== profileId);
    if (next.length === document.profiles.length) {
      return false;
    }
    await this.write({
      ...document,
      profiles: next,
      activeProfileId: document.activeProfileId === profileId ? null : document.activeProfileId
    });
    return true;
  }

  async getActiveProfileId(): Promise<string | null> {
    const document = await this.read();
    return document.activeProfileId;
  }

  async setActiveProfileId(profileId: string | null): Promise<void> {
    const document = await this.read();
    if (profileId === null) {
      await this.write({ ...document, activeProfileId: null });
      return;
    }
    if (
      !document.profiles.some(
        (profile) => profile.profileId === profileId && profile.connectionState === "ready"
      )
    ) {
      throw new Error(`Unknown collaboration profile: ${profileId}`);
    }
    await this.write({ ...document, activeProfileId: profileId });
  }
}
