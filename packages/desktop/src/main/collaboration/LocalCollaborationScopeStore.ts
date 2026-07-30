import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  localCollaborationScopeSchema,
  type LocalCollaborationScope
} from "../../shared/localCollaborationScopes.js";
import { desktopHomePaths } from "../planweaveHomePaths.js";

const documentSchema = z
  .object({
    version: z.literal(1),
    scopes: z.array(localCollaborationScopeSchema).max(256)
  })
  .strict()
  .superRefine((document, context) => {
    const seen = new Set<string>();
    document.scopes.forEach((scope, index) => {
      const key = `${scope.projectId}\0${scope.canvasId}`;
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          message: "local_collaboration_scope_duplicate",
          path: ["scopes", index]
        });
      }
      seen.add(key);
    });
  });

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

export type LocalCollaborationScopeStorePort = {
  read(): Promise<LocalCollaborationScope[]>;
  write(scopes: readonly LocalCollaborationScope[]): Promise<void>;
};

export class LocalCollaborationScopeStore implements LocalCollaborationScopeStorePort {
  constructor(private readonly path: string = desktopHomePaths().localCollaborationScopesFile) {}

  async read(): Promise<LocalCollaborationScope[]> {
    try {
      const parsed = documentSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
      return [...parsed.scopes];
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw new Error("local_collaboration_scope_store_invalid", { cause: error });
    }
  }

  async write(scopes: readonly LocalCollaborationScope[]): Promise<void> {
    const document = documentSchema.parse({ version: 1, scopes: [...scopes] });
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
