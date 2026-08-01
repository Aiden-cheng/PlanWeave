import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { desktopHomePaths } from "../planweaveHomePaths.js";

const identifierSchema = z.string().trim().min(1).max(256);
const remoteReplicaScopeSchema = z
  .object({
    serverOrigin: z.string().url(),
    workspaceId: identifierSchema,
    projectId: identifierSchema,
    canvasId: identifierSchema
  })
  .strict();
const localReplicaScopeSchema = z
  .object({
    projectId: identifierSchema,
    canvasId: identifierSchema
  })
  .strict();
export const collaborationContentReplicaSchema = z
  .object({
    remote: remoteReplicaScopeSchema,
    local: localReplicaScopeSchema,
    phase: z.enum(["importing", "ready"]),
    projectName: identifierSchema.nullable(),
    reservationToken: identifierSchema.nullable().default(null),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();
const documentSchema = z
  .object({
    version: z.literal(2),
    replicas: z.array(collaborationContentReplicaSchema)
  })
  .strict();
const legacyDocumentSchema = z
  .object({
    version: z.literal(1),
    replicas: z.array(
      z
        .object({
          remote: remoteReplicaScopeSchema,
          local: localReplicaScopeSchema,
          createdAt: z.string().datetime(),
          updatedAt: z.string().datetime()
        })
        .strict()
    )
  })
  .strict();

export type CollaborationContentReplica = z.infer<typeof collaborationContentReplicaSchema>;

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function sameRemote(
  left: CollaborationContentReplica["remote"],
  right: CollaborationContentReplica["remote"]
): boolean {
  return (
    left.serverOrigin === right.serverOrigin &&
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.canvasId === right.canvasId
  );
}

function sameLocal(
  left: CollaborationContentReplica["local"],
  right: CollaborationContentReplica["local"]
): boolean {
  return left.projectId === right.projectId && left.canvasId === right.canvasId;
}

export type CollaborationContentReplicaStorePort = {
  list(): Promise<CollaborationContentReplica[]>;
  add(replica: CollaborationContentReplica): Promise<CollaborationContentReplica>;
  reserve(replica: CollaborationContentReplica): Promise<CollaborationContentReplica>;
  complete(remote: CollaborationContentReplica["remote"]): Promise<CollaborationContentReplica>;
  remove(remote: CollaborationContentReplica["remote"]): Promise<void>;
};

const writeLocks = new Map<string, Promise<void>>();

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

/** Main-only, path-free mapping between a Server canvas and one local replica. */
export class CollaborationContentReplicaStore implements CollaborationContentReplicaStorePort {
  constructor(
    private readonly path: string = desktopHomePaths().collaborationContentReplicasFile
  ) {}

  async list(): Promise<CollaborationContentReplica[]> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8"));
      const current = documentSchema.safeParse(raw);
      if (current.success) return [...current.data.replicas];
      const legacy = legacyDocumentSchema.parse(raw);
      return legacy.replicas.map((replica) => ({
        ...replica,
        phase: "ready" as const,
        projectName: null,
        reservationToken: null
      }));
    } catch (error) {
      if (isMissing(error)) return [];
      throw new Error("collaboration_content_replica_store_invalid", { cause: error });
    }
  }

  async add(input: CollaborationContentReplica): Promise<CollaborationContentReplica> {
    return this.writeReplica({ ...input, phase: "ready" });
  }

  async reserve(input: CollaborationContentReplica): Promise<CollaborationContentReplica> {
    return this.writeReplica({ ...input, phase: "importing" });
  }

  async complete(
    input: CollaborationContentReplica["remote"]
  ): Promise<CollaborationContentReplica> {
    const remote = remoteReplicaScopeSchema.parse(input);
    return withWriteLock(this.path, async () => {
      const replicas = await this.list();
      const index = replicas.findIndex((candidate) => sameRemote(candidate.remote, remote));
      if (index < 0) throw new Error("content_replica_reservation_missing");
      const completed = collaborationContentReplicaSchema.parse({
        ...replicas[index],
        phase: "ready",
        updatedAt: new Date().toISOString()
      });
      const next = replicas.map((candidate, candidateIndex) =>
        candidateIndex === index ? completed : candidate
      );
      await this.write(next);
      return completed;
    });
  }

  async remove(input: CollaborationContentReplica["remote"]): Promise<void> {
    const remote = remoteReplicaScopeSchema.parse(input);
    await withWriteLock(this.path, async () => {
      const replicas = await this.list();
      const next = replicas.filter((candidate) => !sameRemote(candidate.remote, remote));
      if (next.length !== replicas.length) await this.write(next);
    });
  }

  private async writeReplica(
    input: CollaborationContentReplica
  ): Promise<CollaborationContentReplica> {
    const replica = collaborationContentReplicaSchema.parse(input);
    return withWriteLock(this.path, async () => {
      const replicas = await this.list();
      const remoteIndex = replicas.findIndex((candidate) =>
        sameRemote(candidate.remote, replica.remote)
      );
      const localIndex = replicas.findIndex((candidate) =>
        sameLocal(candidate.local, replica.local)
      );
      if (remoteIndex >= 0 && !sameLocal(replicas[remoteIndex]!.local, replica.local)) {
        throw new Error("content_replica_remote_conflict");
      }
      if (localIndex >= 0 && !sameRemote(replicas[localIndex]!.remote, replica.remote)) {
        throw new Error("content_replica_local_conflict");
      }
      const next =
        remoteIndex >= 0
          ? replicas.map((candidate, index) =>
              index === remoteIndex ? { ...replica, createdAt: candidate.createdAt } : candidate
            )
          : [...replicas, replica];
      await this.write(next);
      return next.find((candidate) => sameRemote(candidate.remote, replica.remote))!;
    });
  }

  private async write(replicas: CollaborationContentReplica[]): Promise<void> {
    const document = documentSchema.parse({ version: 2, replicas });
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
