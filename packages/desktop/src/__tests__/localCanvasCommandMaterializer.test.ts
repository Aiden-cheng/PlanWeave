import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CANVAS_COMMAND_PROTOCOL_VERSION,
  canvasCommandAcceptedSchema,
  canvasReconnectDeltaSchema,
  canvasReconnectSnapshotSchema
} from "@planweave-ai/collaboration-contracts";
import { applyAuthorizedCanvasCommand } from "@planweave-ai/runtime";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { LocalCanvasCommandMaterializer } from "../main/collaboration/LocalCanvasCommandMaterializer.js";

const directories: string[] = [];
const originalHome = process.env.PLANWEAVE_HOME;
const originalSettingsFile = process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;

afterEach(async () => {
  if (originalHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalHome;
  if (originalSettingsFile === undefined) delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  else process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = originalSettingsFile;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function scope(projectId: string) {
  return { workspaceId: "workspace-001", projectId, canvasId: "default" };
}

describe("LocalCanvasCommandMaterializer", () => {
  it("converges a delta into an independently rooted registered project and skips co-located accepted content", async () => {
    const source = await createTestWorkspace(basicManifest());
    directories.push(source.home, source.root);
    const projectId = source.init.workspace.id;
    const replicaHome = await mkdtemp(join(tmpdir(), "planweave-replica-home-"));
    const replicaRoot = join(replicaHome, "projects", projectId);
    directories.push(replicaHome);
    await cp(source.init.workspace.workspaceRoot, replicaRoot, { recursive: true });

    const updateIntent = {
      kind: "update_task_prompt" as const,
      taskId: "T-001",
      promptMarkdown: "# replicated prompt\n"
    };
    const sourceResult = await applyAuthorizedCanvasCommand({
      projectRoot: source.init.workspace,
      canvasId: "default",
      intent: updateIntent
    });
    if (!sourceResult.ok) throw new Error(sourceResult.code);

    process.env.PLANWEAVE_HOME = replicaHome;
    process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = join(replicaHome, "desktop-settings.json");
    const replicaMaterializer = new LocalCanvasCommandMaterializer();
    const replicaBinding = await replicaMaterializer.bind({
      projectRoot: replicaRoot,
      projectId,
      canvasId: "default"
    });
    const delta = canvasReconnectDeltaSchema.parse({
      type: "canvas.reconnect.delta",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      scope: scope(projectId),
      afterRevision: 0,
      headRevision: 1,
      headContentDigest: sourceResult.contentDigest,
      entries: [
        {
          schemaVersion: "canvas-journal/v1",
          entryId: "journal-001",
          scope: scope(projectId),
          revision: 1,
          previousRevision: 0,
          operationId: "operation-001",
          intent: updateIntent,
          intentDigest: "0".repeat(64),
          contentDigest: sourceResult.contentDigest,
          actor: { kind: "human", id: "human-001", displayName: "Replica writer" },
          acceptedAt: "2026-07-28T00:00:00.000Z"
        }
      ]
    });
    await replicaMaterializer.materializeReconnect(replicaBinding, {
      response: delta,
      entriesToApply: delta.entries,
      snapshotRequired: false
    });
    await expect(
      readFile(join(replicaRoot, "canvases", "default", "package", "nodes", "T-001", "prompt.md"), "utf8")
    ).resolves.toBe("# replicated prompt\n");

    process.env.PLANWEAVE_HOME = source.home;
    process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = join(source.home, "desktop-settings.json");
    const sourceMaterializer = new LocalCanvasCommandMaterializer();
    const sourceBinding = await sourceMaterializer.bind({
      projectRoot: source.root,
      projectId,
      canvasId: "default"
    });
    const removeIntent = { kind: "remove_task" as const, taskId: "T-001" };
    const removed = await applyAuthorizedCanvasCommand({
      projectRoot: source.init.workspace,
      canvasId: "default",
      intent: removeIntent
    });
    if (!removed.ok) throw new Error(removed.code);
    const accepted = canvasCommandAcceptedSchema.parse({
      type: "canvas.command.accepted",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      scope: scope(projectId),
      operationId: "operation-002",
      revision: 2,
      previousRevision: 1,
      contentDigest: removed.contentDigest,
      journalEntryId: "journal-002",
      actor: { kind: "human", id: "human-001", displayName: "Source writer" },
      acceptedAt: "2026-07-28T00:01:00.000Z",
      idempotentReplay: false
    });
    await expect(
      sourceMaterializer.materializeAccepted(sourceBinding, accepted, removeIntent)
    ).resolves.toBeUndefined();

    const snapshot = canvasReconnectSnapshotSchema.parse({
      type: "canvas.reconnect.snapshot",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      scope: scope(projectId),
      reason: "retention_gap",
      afterRevision: 1,
      snapshot: {
        metadata: {
          schemaVersion: "canvas-snapshot/v1",
          scope: scope(projectId),
          revision: 2,
          contentDigest: removed.contentDigest,
          createdAt: "2026-07-28T00:01:00.000Z",
          digestManifest: removed.digestManifest
        },
        encoding: "digest_manifest_only",
        digestManifest: removed.digestManifest
      }
    });
    await expect(
      sourceMaterializer.materializeReconnect(sourceBinding, {
        response: snapshot,
        entriesToApply: [],
        snapshotRequired: true
      })
    ).rejects.toMatchObject({ code: "collaboration_canvas_snapshot_materialization_required", retryable: true });
  });
});
