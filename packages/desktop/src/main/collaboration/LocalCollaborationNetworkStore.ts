import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { desktopHomePaths } from "../planweaveHomePaths.js";

const legacyExposureModeSchema = z.enum(["local_only", "tailscale_private", "lan_http"]);
const localExposureModeSchema = z.enum(["local_only", "private_https", "lan_http"]);

const preferredPortSchema = z.number().int().min(1).max(65_535).nullable();
const legacyDocumentSchema = z
  .object({ version: z.literal(1), lanSharingEnabled: z.boolean() })
  .strict();
const documentSchema = z
  .object({
    version: z.literal(2),
    lanSharingEnabled: z.boolean(),
    preferredPort: preferredPortSchema
  })
  .strict();
const previousDocumentSchema = z
  .object({
    version: z.literal(3),
    exposureMode: legacyExposureModeSchema,
    preferredPort: preferredPortSchema
  })
  .strict();
const currentDocumentSchema = z
  .object({
    version: z.literal(4),
    exposureMode: localExposureModeSchema,
    preferredPort: preferredPortSchema
  })
  .strict();
const storedDocumentSchema = z.discriminatedUnion("version", [
  legacyDocumentSchema,
  documentSchema,
  previousDocumentSchema,
  currentDocumentSchema
]);

export type LocalCollaborationNetworkState = {
  lanSharingEnabled: boolean;
  exposureMode?: "local_only" | "private_https" | "lan_http";
  preferredPort: number | null;
};

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export type LocalCollaborationNetworkStorePort = {
  read(): Promise<LocalCollaborationNetworkState>;
  write(input: LocalCollaborationNetworkState): Promise<void>;
};

export class LocalCollaborationNetworkStore implements LocalCollaborationNetworkStorePort {
  constructor(private readonly path: string = desktopHomePaths().localCollaborationNetworkFile) {}

  async read(): Promise<LocalCollaborationNetworkState> {
    try {
      const document = storedDocumentSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
      return {
        lanSharingEnabled:
          document.version === 3 || document.version === 4
            ? document.exposureMode === "lan_http"
            : document.lanSharingEnabled,
        exposureMode:
          document.version === 4
            ? document.exposureMode
            : document.version === 3
              ? document.exposureMode === "tailscale_private"
                ? "private_https"
                : document.exposureMode
            : document.lanSharingEnabled
              ? "lan_http"
              : "local_only",
        preferredPort: document.version === 1 ? null : document.preferredPort
      };
    } catch (error) {
      if (isMissingFile(error)) {
        return { lanSharingEnabled: false, exposureMode: "local_only", preferredPort: null };
      }
      throw new Error("local_collaboration_network_store_invalid", { cause: error });
    }
  }

  async write(input: LocalCollaborationNetworkState): Promise<void> {
    const document = currentDocumentSchema.parse({
      version: 4,
      exposureMode: input.exposureMode ?? (input.lanSharingEnabled ? "lan_http" : "local_only"),
      preferredPort: input.preferredPort
    });
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporaryPath, this.path);
    if (((await stat(this.path)).mode & 0o777) !== 0o600) await chmod(this.path, 0o600);
  }
}
