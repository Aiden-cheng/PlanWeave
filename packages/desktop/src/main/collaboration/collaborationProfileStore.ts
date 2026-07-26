import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  collaborationConnectionProfileSchema,
  opaqueIdentifierSchema,
  timestampSchema,
  type CollaborationConnectionProfile
} from "@planweave-ai/collaboration-contracts";
import { z } from "zod";
import { desktopHomePaths } from "../planweaveHomePaths.js";

const storedCollaborationProfileSchema = collaborationConnectionProfileSchema.extend({
  updatedAt: timestampSchema
});

const collaborationProfilesDocumentSchema = z
  .object({
    version: z.literal(1),
    profiles: z.array(storedCollaborationProfileSchema),
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
      !document.profiles.some((profile) => profile.profileId === document.activeProfileId)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "active collaboration profile is missing",
        path: ["activeProfileId"]
      });
    }
  });

export type StoredCollaborationProfile = z.infer<typeof storedCollaborationProfileSchema>;
export type CollaborationProfilesDocument = z.infer<typeof collaborationProfilesDocumentSchema>;

function defaultDocument(): CollaborationProfilesDocument {
  return {
    version: 1,
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
  await rename(tmp, path);
  const written = await stat(path);
  if ((written.mode & 0o777) !== 0o600) {
    await chmod(path, 0o600);
  }
}

export class CollaborationProfileStore {
  private readonly paths: CollaborationProfileStorePaths;
  private loaded: CollaborationProfilesDocument | null = null;

  constructor(paths: CollaborationProfileStorePaths = collaborationProfileStorePaths()) {
    this.paths = paths;
  }

  get profilesPath(): string {
    return this.paths.profilesPath;
  }

  async read(): Promise<CollaborationProfilesDocument> {
    if (this.loaded) {
      return this.loaded;
    }
    let raw: string;
    try {
      raw = await readFile(this.paths.profilesPath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        this.loaded = defaultDocument();
        return this.loaded;
      }
      throw new Error("Failed to read collaboration profiles.");
    }
    try {
      this.loaded = collaborationProfilesDocumentSchema.parse(JSON.parse(raw));
      return this.loaded;
    } catch {
      throw new Error("Invalid collaboration profiles JSON.");
    }
  }

  async write(document: CollaborationProfilesDocument): Promise<CollaborationProfilesDocument> {
    const parsed = collaborationProfilesDocumentSchema.parse(document);
    await writePrivateJson(this.paths.profilesPath, parsed);
    this.loaded = parsed;
    return parsed;
  }

  async list(): Promise<StoredCollaborationProfile[]> {
    const document = await this.read();
    return [...document.profiles];
  }

  async get(profileId: string): Promise<StoredCollaborationProfile | null> {
    const document = await this.read();
    return document.profiles.find((profile) => profile.profileId === profileId) ?? null;
  }

  async upsert(profile: CollaborationConnectionProfile): Promise<StoredCollaborationProfile> {
    const document = await this.read();
    const stored: StoredCollaborationProfile = {
      ...collaborationConnectionProfileSchema.parse(profile),
      updatedAt: nowIso()
    };
    const index = document.profiles.findIndex((entry) => entry.profileId === stored.profileId);
    if (index >= 0) {
      document.profiles[index] = stored;
    } else {
      document.profiles.push(stored);
    }
    await this.write(document);
    return stored;
  }

  async remove(profileId: string): Promise<boolean> {
    const document = await this.read();
    const next = document.profiles.filter((profile) => profile.profileId !== profileId);
    if (next.length === document.profiles.length) {
      return false;
    }
    document.profiles = next;
    if (document.activeProfileId === profileId) {
      document.activeProfileId = null;
    }
    await this.write(document);
    return true;
  }

  async getActiveProfileId(): Promise<string | null> {
    const document = await this.read();
    return document.activeProfileId;
  }

  async setActiveProfileId(profileId: string | null): Promise<void> {
    const document = await this.read();
    if (profileId === null) {
      document.activeProfileId = null;
      await this.write(document);
      return;
    }
    if (!document.profiles.some((profile) => profile.profileId === profileId)) {
      throw new Error(`Unknown collaboration profile: ${profileId}`);
    }
    document.activeProfileId = profileId;
    await this.write(document);
  }
}
