import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  collaborationConnectionProfileSchema,
  type CollaborationConnectionProfile
} from "@planweave-ai/collaboration-contracts";
import { desktopHomePaths } from "../planweaveHomePaths.js";

export type StoredCollaborationProfile = CollaborationConnectionProfile & {
  updatedAt: string;
};

export type CollaborationProfilesDocument = {
  version: 1;
  profiles: StoredCollaborationProfile[];
  activeProfileId: string | null;
};

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

function normalizeProfile(value: unknown): StoredCollaborationProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  // Drop non-schema and secret fields before strict schema parse.
  const profileCandidate = {
    profileId: record.profileId,
    displayName: record.displayName,
    serverBaseUrl: record.serverBaseUrl,
    projectId: record.projectId,
    allowInsecureTransport: record.allowInsecureTransport
  };

  const parsed = collaborationConnectionProfileSchema.safeParse(profileCandidate);
  if (!parsed.success) {
    return null;
  }
  const updatedAt =
    typeof record.updatedAt === "string" && record.updatedAt.trim()
      ? record.updatedAt.trim()
      : nowIso();
  return {
    ...parsed.data,
    updatedAt
  };
}

function normalizeDocument(value: unknown): CollaborationProfilesDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaultDocument();
  }
  const record = value as Record<string, unknown>;
  const rawProfiles = Array.isArray(record.profiles) ? record.profiles : [];
  const profiles: StoredCollaborationProfile[] = [];
  const seen = new Set<string>();
  for (const entry of rawProfiles) {
    const profile = normalizeProfile(entry);
    if (!profile || seen.has(profile.profileId)) {
      continue;
    }
    seen.add(profile.profileId);
    profiles.push(profile);
  }
  const activeProfileId =
    typeof record.activeProfileId === "string" && record.activeProfileId.trim()
      ? record.activeProfileId.trim()
      : null;
  return {
    version: 1,
    profiles,
    activeProfileId:
      activeProfileId && profiles.some((profile) => profile.profileId === activeProfileId)
        ? activeProfileId
        : null
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
      this.loaded = normalizeDocument(JSON.parse(raw));
      return this.loaded;
    } catch {
      throw new Error("Invalid collaboration profiles JSON.");
    }
  }

  async write(document: CollaborationProfilesDocument): Promise<CollaborationProfilesDocument> {
    const normalized = normalizeDocument(document);
    await writePrivateJson(this.paths.profilesPath, normalized);
    this.loaded = normalized;
    return normalized;
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
