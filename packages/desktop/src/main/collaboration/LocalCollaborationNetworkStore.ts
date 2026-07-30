import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { desktopHomePaths } from "../planweaveHomePaths.js";

const documentSchema = z
  .object({ version: z.literal(1), lanSharingEnabled: z.boolean() })
  .strict();

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export type LocalCollaborationNetworkStorePort = {
  read(): Promise<{ lanSharingEnabled: boolean }>;
  write(input: { lanSharingEnabled: boolean }): Promise<void>;
};

export class LocalCollaborationNetworkStore implements LocalCollaborationNetworkStorePort {
  constructor(private readonly path: string = desktopHomePaths().localCollaborationNetworkFile) {}

  async read(): Promise<{ lanSharingEnabled: boolean }> {
    try {
      const document = documentSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
      return { lanSharingEnabled: document.lanSharingEnabled };
    } catch (error) {
      if (isMissingFile(error)) return { lanSharingEnabled: false };
      throw new Error("local_collaboration_network_store_invalid", { cause: error });
    }
  }

  async write(input: { lanSharingEnabled: boolean }): Promise<void> {
    const document = documentSchema.parse({ version: 1, ...input });
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
