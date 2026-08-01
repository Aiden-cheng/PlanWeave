import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { CollaborationContentReplicaStore } from "../main/collaboration/CollaborationContentReplicaStore.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function replica() {
  return {
    remote: {
      serverOrigin: "http://192.168.1.10:50653",
      workspaceId: "workspace-main",
      projectId: "remote-project",
      canvasId: "canvas-main"
    },
    local: {
      projectId: "local-project",
      canvasId: "default"
    },
    phase: "ready" as const,
    projectName: "Local project",
    reservationToken: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z"
  };
}

describe("CollaborationContentReplicaStore", () => {
  it("persists a remote-to-local mapping across store instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-content-replicas-"));
    directories.push(directory);
    const path = join(directory, "content-replicas.json");

    await new CollaborationContentReplicaStore(path).add(replica());

    await expect(new CollaborationContentReplicaStore(path).list()).resolves.toEqual([replica()]);
    await expect(readFile(path, "utf8")).resolves.not.toContain("projectRoot");
  });

  it("is idempotent for the same mapping and rejects remote or local identity conflicts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-content-replicas-"));
    directories.push(directory);
    const store = new CollaborationContentReplicaStore(join(directory, "content-replicas.json"));
    await store.add(replica());

    await expect(
      store.add({ ...replica(), updatedAt: "2026-08-01T00:01:00.000Z" })
    ).resolves.toMatchObject({
      local: replica().local
    });
    await expect(
      store.add({
        ...replica(),
        local: { projectId: "other-local", canvasId: "default" }
      })
    ).rejects.toThrow("content_replica_remote_conflict");
    await expect(
      store.add({
        ...replica(),
        remote: { ...replica().remote, canvasId: "other-canvas" }
      })
    ).rejects.toThrow("content_replica_local_conflict");
  });

  it("serializes writes from separate store instances without losing mappings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-content-replicas-"));
    directories.push(directory);
    const path = join(directory, "content-replicas.json");
    const first = new CollaborationContentReplicaStore(path);
    const second = new CollaborationContentReplicaStore(path);

    await Promise.all([
      first.add(replica()),
      second.add({
        ...replica(),
        remote: { ...replica().remote, canvasId: "canvas-other" },
        local: { projectId: "local-other", canvasId: "default" }
      })
    ]);

    await expect(first.list()).resolves.toHaveLength(2);
  });
});
