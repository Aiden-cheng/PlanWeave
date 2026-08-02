import { describe, expect, it } from "vitest";
import {
  canvasScopeRefSchema,
  exampleAuthoritativeContentVersion
} from "@planweave-ai/collaboration-contracts";
import { CanvasReplicaStore } from "../main/collaboration/CanvasReplicaStore.js";
import type { CollaborationCanvasReplicaProjection } from "../shared/canvasReplicaIpc.js";

const scope = {
  localProjectId: "local-project",
  localCanvasId: "local-canvas",
  projectId: "project-authority",
  canvasId: "default",
  workspaceId: canvasScopeRefSchema.parse({
    workspaceId: "workspace-authority",
    projectId: "project-authority",
    canvasId: "default"
  }).workspaceId
};

describe("CanvasReplicaStore", () => {
  it("rejects malformed immutable snapshots before they become a replica baseline", () => {
    const published: CollaborationCanvasReplicaProjection[] = [];
    const store = new CanvasReplicaStore((projection) => published.push(projection));
    store.bind(scope);
    expect(() => store.replaceFromReconnect({
      scope,
      response: {
        type: "canvas.reconnect.snapshot",
        protocolVersion: 1,
        schemaVersion: "canvas-command/v1",
        projectId: scope.projectId,
        canvasId: scope.canvasId,
        snapshot: {
          metadata: {
            schemaVersion: "canvas-snapshot/v2",
            scope: canvasScopeRefSchema.parse({
              workspaceId: "workspace-authority",
              projectId: scope.projectId,
              canvasId: scope.canvasId
            }),
            revision: 0,
            contentDigest: exampleAuthoritativeContentVersion.canonicalDigest,
            createdAt: "2026-08-02T00:00:00.000Z"
          },
          content: {
            versionId: "version-authority",
            canonicalDigest: exampleAuthoritativeContentVersion.canonicalDigest
          }
        }
      },
      snapshotContent: exampleAuthoritativeContentVersion.content
    })).toThrow();
    expect(store.projection(scope)).toBeNull();
    expect(published).toHaveLength(0);
  });
});
