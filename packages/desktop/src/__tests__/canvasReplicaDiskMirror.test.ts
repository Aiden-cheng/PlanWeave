import { describe, expect, it, vi } from "vitest";
import { encodeCanvasReplicaDocument, parseCanvasReplicaDocument } from "@planweave-ai/runtime";
import { basicManifest } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { CanvasReplicaDiskMirror } from "../main/collaboration/CanvasReplicaDiskMirror.js";
import type { CanvasReplicaScope } from "../main/collaboration/CanvasReplicaStore.js";

function content() {
  const manifest = basicManifest();
  return encodeCanvasReplicaDocument(
    parseCanvasReplicaDocument({
      schemaVersion: "canvas-replica-document/v1",
      manifest,
      promptMarkdownByPath: Object.fromEntries(
        manifest.nodes.flatMap((task) => [
          [task.prompt, `# ${task.id}\n`],
          ...task.blocks.map((block) => [block.prompt, `# ${block.id}\n`])
        ])
      ),
      layout: {
        version: "desktop-layout/v1",
        projectId: "remote-project",
        nodes: [{ nodeId: "T-001", x: 0, y: 0 }],
        updatedAt: "2026-08-03T00:00:00.000Z"
      }
    })
  );
}

function scope(authorityId = "authority-1"): CanvasReplicaScope {
  return {
    authorityId,
    localProjectId: "local-project",
    localCanvasId: "local-canvas",
    workspaceId: "workspace-1",
    projectId: "remote-project",
    canvasId: "remote-canvas"
  };
}

describe("CanvasReplicaDiskMirror", () => {
  it("serializes confirmed revisions into the bound local replica", async () => {
    const localBinding = { expectedContentDigest: "a".repeat(64) };
    const materializeConfirmed = vi.fn().mockResolvedValue(undefined);
    const mirror = new CanvasReplicaDiskMirror({
      bind: vi.fn().mockResolvedValue(localBinding),
      materializeConfirmed
    });
    const committed = content();

    await mirror.bind(scope());
    mirror.capture({
      scope: scope(),
      revision: 4,
      contentDigest: committed.canonicalDigest,
      content: committed
    });
    await mirror.flush();

    expect(materializeConfirmed).toHaveBeenCalledWith(localBinding, {
      content: committed,
      contentDigest: committed.canonicalDigest
    });
  });

  it("surfaces persistence failures instead of marking the replica durable", async () => {
    const mirror = new CanvasReplicaDiskMirror({
      bind: vi.fn().mockResolvedValue({ expectedContentDigest: "a".repeat(64) }),
      materializeConfirmed: vi.fn().mockRejectedValue(new Error("disk full"))
    });
    const committed = content();

    await mirror.bind(scope());
    mirror.capture({
      scope: scope(),
      revision: 4,
      contentDigest: committed.canonicalDigest,
      content: committed
    });

    await expect(mirror.flush()).rejects.toThrow("disk full");
  });
});
