import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { CollaborationRuntimeStatusStore } from "../main/collaboration/CollaborationRuntimeStatusStore.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const key = {
  profileId: "profile-1",
  serverOrigin: "http://192.168.1.10:50653",
  projectId: "remote-project",
  localProjectId: "local-project",
  localCanvasId: "default"
};

const status = {
  schemaVersion: "canvas-runtime-status/v2" as const,
  scope: {
    workspaceId: "workspace-main",
    projectId: "remote-project",
    canvasId: "canvas-main"
  },
  packageFingerprint: `pkg-${"a".repeat(64)}`,
  capturedAt: "2026-08-03T00:00:00.000Z",
  tasks: [{ taskId: "T-001", status: "implemented" as const, openFeedbackCount: 0 }],
  blocks: [
    {
      ref: "T-001#B-001",
      status: "completed" as const,
      completionReason: "passed" as const,
      blockedReason: null,
      divergenceReason: null,
      dispatchable: false
    }
  ]
};

describe("CollaborationRuntimeStatusStore", () => {
  it("persists the last confirmed status for one exact authority and local replica", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-runtime-status-"));
    directories.push(directory);
    const path = join(directory, "runtime-status.json");

    await new CollaborationRuntimeStatusStore(path).put(key, status);

    await expect(new CollaborationRuntimeStatusStore(path).get(key)).resolves.toEqual(status);
    await expect(
      new CollaborationRuntimeStatusStore(path).get({ ...key, profileId: "profile-2" })
    ).resolves.toBeNull();
    await expect(readFile(path, "utf8")).resolves.not.toContain("projectRoot");
  });

  it("does not rewrite the cache when only capturedAt changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-runtime-status-"));
    directories.push(directory);
    const path = join(directory, "runtime-status.json");
    const store = new CollaborationRuntimeStatusStore(path);

    await store.put(key, status);
    const before = await readFile(path, "utf8");
    await store.put(key, { ...status, capturedAt: "2026-08-03T00:00:03.000Z" });

    await expect(readFile(path, "utf8")).resolves.toBe(before);
    await expect(store.get(key)).resolves.toEqual(status);
  });
});
