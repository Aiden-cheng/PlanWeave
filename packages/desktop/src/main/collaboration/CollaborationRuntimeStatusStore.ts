import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canvasRuntimeStatusProjectionSchema } from "@planweave-ai/collaboration-protocol/canvas/status";
import type { CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-protocol/canvas/status";
import { z } from "zod";
import { desktopHomePaths } from "../planweaveHomePaths.js";

const identifierSchema = z.string().trim().min(1).max(256);
export const collaborationRuntimeStatusKeySchema = z
  .object({
    profileId: identifierSchema,
    serverOrigin: z.string().url(),
    projectId: identifierSchema,
    localProjectId: identifierSchema,
    localCanvasId: identifierSchema
  })
  .strict();
const recordSchema = z
  .object({
    key: collaborationRuntimeStatusKeySchema,
    status: canvasRuntimeStatusProjectionSchema
  })
  .strict()
  .superRefine((record, context) => {
    if (record.status.scope.projectId !== record.key.projectId) {
      context.addIssue({
        code: "custom",
        path: ["status", "scope", "projectId"],
        message: "runtime_status_project_scope_mismatch"
      });
    }
  });
const documentSchema = z
  .object({
    version: z.literal(1),
    records: z.array(recordSchema).max(10_000)
  })
  .strict();

export type CollaborationRuntimeStatusKey = z.infer<typeof collaborationRuntimeStatusKeySchema>;

export type CollaborationRuntimeStatusStorePort = {
  get(key: CollaborationRuntimeStatusKey): Promise<CanvasRuntimeStatusProjection | null>;
  put(
    key: CollaborationRuntimeStatusKey,
    status: CanvasRuntimeStatusProjection
  ): Promise<CanvasRuntimeStatusProjection>;
};

const writeLocks = new Map<string, Promise<void>>();

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function sameKey(
  left: CollaborationRuntimeStatusKey,
  right: CollaborationRuntimeStatusKey
): boolean {
  return (
    left.profileId === right.profileId &&
    left.serverOrigin === right.serverOrigin &&
    left.projectId === right.projectId &&
    left.localProjectId === right.localProjectId &&
    left.localCanvasId === right.localCanvasId
  );
}

function sameDurableStatus(
  left: CanvasRuntimeStatusProjection,
  right: CanvasRuntimeStatusProjection
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.scope.workspaceId === right.scope.workspaceId &&
    left.scope.projectId === right.scope.projectId &&
    left.scope.canvasId === right.scope.canvasId &&
    left.packageFingerprint === right.packageFingerprint &&
    JSON.stringify(left.tasks) === JSON.stringify(right.tasks) &&
    JSON.stringify(left.blocks) === JSON.stringify(right.blocks)
  );
}

async function withWriteLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => gate);
  writeLocks.set(path, queued);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (writeLocks.get(path) === queued) writeLocks.delete(path);
  }
}

/** Main-only cache of the last server-confirmed runtime projection for an exact replica. */
export class CollaborationRuntimeStatusStore implements CollaborationRuntimeStatusStorePort {
  private loaded: z.infer<typeof documentSchema> | null = null;

  constructor(private readonly path: string = desktopHomePaths().collaborationRuntimeStatusFile) {}

  async get(input: CollaborationRuntimeStatusKey): Promise<CanvasRuntimeStatusProjection | null> {
    const key = collaborationRuntimeStatusKeySchema.parse(input);
    const document = await this.read();
    return document.records.find((record) => sameKey(record.key, key))?.status ?? null;
  }

  async put(
    inputKey: CollaborationRuntimeStatusKey,
    inputStatus: CanvasRuntimeStatusProjection
  ): Promise<CanvasRuntimeStatusProjection> {
    const parsed = recordSchema.parse({ key: inputKey, status: inputStatus });
    return withWriteLock(this.path, async () => {
      const document = await this.read();
      const index = document.records.findIndex((record) => sameKey(record.key, parsed.key));
      const current = index >= 0 ? document.records[index]! : null;
      if (current && sameDurableStatus(current.status, parsed.status)) return current.status;
      const records =
        index >= 0
          ? document.records.map((record, recordIndex) => (recordIndex === index ? parsed : record))
          : [...document.records, parsed];
      await this.write(documentSchema.parse({ version: 1, records }));
      return parsed.status;
    });
  }

  private async read(): Promise<z.infer<typeof documentSchema>> {
    if (this.loaded) return this.loaded;
    try {
      this.loaded = documentSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
      return this.loaded;
    } catch (error) {
      if (isMissing(error)) {
        this.loaded = { version: 1, records: [] };
        return this.loaded;
      }
      throw new Error("collaboration_runtime_status_store_invalid", { cause: error });
    }
  }

  private async write(document: z.infer<typeof documentSchema>): Promise<void> {
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporaryPath, this.path);
    if (((await stat(this.path)).mode & 0o777) !== 0o600) await chmod(this.path, 0o600);
    this.loaded = document;
  }
}
