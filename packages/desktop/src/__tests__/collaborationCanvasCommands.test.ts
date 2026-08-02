import { describe, expect, it, vi } from "vitest";
import {
  CANVAS_COMMAND_PROTOCOL_VERSION,
  canvasReconnectDeltaSchema,
  exampleCanvasCommandAccepted
} from "@planweave-ai/collaboration-contracts";
import type { CollaborationClient } from "../main/collaboration/CollaborationClient.js";
import { CollaborationCanvasCommandFacade } from "../main/collaboration/collaborationCanvasCommands.js";
import { CollaborationClientError } from "../main/collaboration/collaborationErrors.js";
import type { LocalCanvasCommandBinding } from "../main/collaboration/LocalCanvasCommandMaterializer.js";
import type { CollaborationCanvasCommandSessionView } from "../shared/collaboration.js";

const remoteSession: CollaborationCanvasCommandSessionView = {
  canvasId: "remote-canvas",
  revision: 1,
  contentDigest: "a".repeat(64),
  lastOperationId: null,
  lastJournalEntryId: null,
  pendingOperationId: null,
  lastConflict: null,
  lastRejectCode: null
};

describe("CollaborationCanvasCommandFacade", () => {
  it("sends the caller-stamped layout mutation unchanged", async () => {
    const submitCanvasCommand = vi.fn<CollaborationClient["submitCanvasCommand"]>(
      async () => exampleCanvasCommandAccepted
    );
    const client = {
      projectId: "remote-project",
      submitCanvasCommand,
      reconnectCanvasCommands: vi.fn<CollaborationClient["reconnectCanvasCommands"]>(),
      bindCanvasCommandSession: vi.fn<CollaborationClient["bindCanvasCommandSession"]>(),
      canvasCommandSession: vi.fn<CollaborationClient["canvasCommandSession"]>(() => remoteSession)
    };
    const localBinding: LocalCanvasCommandBinding = {
      projectId: "local-project",
      authorityProjectId: "remote-project",
      projectRoot: "/local/project",
      canvasId: "local-canvas",
      expectedPackageDir: "/local/project/package",
      expectedContentDigest: "b".repeat(64)
    };
    const facade = new CollaborationCanvasCommandFacade(
      () => client,
      async () => ({
        localProjectId: "local-project",
        localCanvasId: "local-canvas",
        remoteProjectId: "remote-project",
        remoteCanvasId: "remote-canvas"
      }),
      {
        bind: vi.fn(async () => localBinding),
        materializeAccepted: vi.fn(),
        materializeReconnect: vi.fn()
      }
    );
    await facade.bind({ localProjectId: "local-project", canvasId: "local-canvas" });

    await facade.submit({
      canvasId: "remote-canvas",
      intent: {
        kind: "update_layout",
        nodes: [{ nodeId: "T-001", x: 1, y: 2 }],
        updatedAt: "2026-08-02T00:00:00.000Z"
      }
    });

    expect(submitCanvasCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({
          kind: "update_layout",
          updatedAt: "2026-08-02T00:00:00.000Z"
        })
      }),
      undefined,
      expect.any(Object)
    );
  });

  it("binds imported replicas locally while opening the remote command session", async () => {
    const bindCanvasCommandSession = vi.fn<CollaborationClient["bindCanvasCommandSession"]>();
    const client = {
      projectId: "remote-project",
      submitCanvasCommand: vi.fn<CollaborationClient["submitCanvasCommand"]>(),
      reconnectCanvasCommands: vi.fn<CollaborationClient["reconnectCanvasCommands"]>(),
      bindCanvasCommandSession,
      canvasCommandSession: vi.fn<CollaborationClient["canvasCommandSession"]>(
        () => remoteSession
      )
    };
    const localBinding: LocalCanvasCommandBinding = {
      projectId: "local-project",
      authorityProjectId: "remote-project",
      projectRoot: "/local/project",
      canvasId: "local-canvas",
      expectedPackageDir: "/local/project/package",
      expectedContentDigest: "b".repeat(64)
    };
    const bindLocal = vi.fn(async () => localBinding);
    const facade = new CollaborationCanvasCommandFacade(
      () => client,
      async () => ({
        localProjectId: "local-project",
        localCanvasId: "local-canvas",
        remoteProjectId: "remote-project",
        remoteCanvasId: "remote-canvas"
      }),
      {
        bind: bindLocal,
        materializeAccepted: vi.fn(),
        materializeReconnect: vi.fn()
      }
    );

    await expect(
      facade.bind({ localProjectId: "local-project", canvasId: "local-canvas" })
    ).resolves.toEqual(remoteSession);
    expect(bindLocal).toHaveBeenCalledWith({
      projectId: "local-project",
      canvasId: "local-canvas",
      authorityProjectId: "remote-project"
    });
    expect(bindCanvasCommandSession).toHaveBeenCalledWith("remote-canvas");
  });

  it("sends the bound local digest when reconnect starts at revision zero", async () => {
    const response = canvasReconnectDeltaSchema.parse({
      type: "canvas.reconnect.delta",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      scope: {
        workspaceId: "workspace-001",
        projectId: "remote-project",
        canvasId: "remote-canvas"
      },
      afterRevision: 0,
      headRevision: 0,
      headContentDigest: "b".repeat(64),
      entries: []
    });
    const reconnectCanvasCommands = vi.fn<CollaborationClient["reconnectCanvasCommands"]>(
      async () => ({
        response,
        entriesToApply: [],
        snapshotRequired: false,
        session: { ...remoteSession, revision: 0, contentDigest: "b".repeat(64) }
      })
    );
    const client = {
      projectId: "remote-project",
      submitCanvasCommand: vi.fn<CollaborationClient["submitCanvasCommand"]>(),
      reconnectCanvasCommands,
      bindCanvasCommandSession: vi.fn<CollaborationClient["bindCanvasCommandSession"]>(),
      canvasCommandSession: vi.fn<CollaborationClient["canvasCommandSession"]>(() => remoteSession)
    };
    const localBinding: LocalCanvasCommandBinding = {
      projectId: "local-project",
      authorityProjectId: "remote-project",
      projectRoot: "/local/project",
      canvasId: "local-canvas",
      expectedPackageDir: "/local/project/package",
      expectedContentDigest: "b".repeat(64)
    };
    const facade = new CollaborationCanvasCommandFacade(
      () => client,
      async () => ({
        localProjectId: "local-project",
        localCanvasId: "local-canvas",
        remoteProjectId: "remote-project",
        remoteCanvasId: "remote-canvas"
      }),
      {
        bind: vi.fn(async () => localBinding),
        materializeAccepted: vi.fn(),
        materializeReconnect: vi.fn()
      }
    );
    await facade.bind({ localProjectId: "local-project", canvasId: "local-canvas" });

    await facade.reconnect({ canvasId: "remote-canvas", afterRevision: 0 });

    expect(reconnectCanvasCommands).toHaveBeenCalledWith(
      {
        canvasId: "remote-canvas",
        afterRevision: 0,
        afterContentDigest: localBinding.expectedContentDigest
      },
      undefined,
      expect.any(Object)
    );
  });

  it("materializes the authoritative head and retries once when the baseline needs a snapshot", async () => {
    const response = canvasReconnectDeltaSchema.parse({
      type: "canvas.reconnect.delta",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      scope: {
        workspaceId: "workspace-001",
        projectId: "remote-project",
        canvasId: "remote-canvas"
      },
      afterRevision: 0,
      headRevision: 0,
      headContentDigest: "c".repeat(64),
      entries: []
    });
    const reconnectCanvasCommands = vi
      .fn<CollaborationClient["reconnectCanvasCommands"]>()
      .mockRejectedValueOnce(
        new CollaborationClientError({
          kind: "unknown",
          code: "collaboration_canvas_snapshot_materialization_required",
          message: "collaboration_canvas_snapshot_materialization_required",
          retryable: true
        })
      )
      .mockResolvedValueOnce({
        response,
        entriesToApply: [],
        snapshotRequired: false,
        session: { ...remoteSession, revision: 0, contentDigest: "c".repeat(64) }
      });
    const client = {
      projectId: "remote-project",
      submitCanvasCommand: vi.fn<CollaborationClient["submitCanvasCommand"]>(),
      reconnectCanvasCommands,
      bindCanvasCommandSession: vi.fn<CollaborationClient["bindCanvasCommandSession"]>(),
      canvasCommandSession: vi.fn<CollaborationClient["canvasCommandSession"]>(() => remoteSession)
    };
    const before: LocalCanvasCommandBinding = {
      projectId: "local-project",
      authorityProjectId: "remote-project",
      projectRoot: "/local/project",
      canvasId: "local-canvas",
      expectedPackageDir: "/local/project/package",
      expectedContentDigest: "b".repeat(64)
    };
    const after = { ...before, expectedContentDigest: "c".repeat(64) };
    const bindLocal = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    const recoverAuthoritativeContent = vi.fn(async () => undefined);
    const facade = new CollaborationCanvasCommandFacade(
      () => client,
      async () => ({
        localProjectId: "local-project",
        localCanvasId: "local-canvas",
        remoteProjectId: "remote-project",
        remoteCanvasId: "remote-canvas"
      }),
      {
        bind: bindLocal,
        materializeAccepted: vi.fn(),
        materializeReconnect: vi.fn()
      },
      recoverAuthoritativeContent
    );
    await facade.bind({ localProjectId: "local-project", canvasId: "local-canvas" });

    await expect(
      facade.reconnect({ canvasId: "remote-canvas", afterRevision: 0 })
    ).resolves.toMatchObject({ response });

    expect(recoverAuthoritativeContent).toHaveBeenCalledWith({
      localProjectId: "local-project",
      localCanvasId: "local-canvas"
    });
    expect(reconnectCanvasCommands).toHaveBeenNthCalledWith(
      2,
      {
        canvasId: "remote-canvas",
        afterRevision: 0,
        afterContentDigest: after.expectedContentDigest
      },
      undefined,
      expect.any(Object)
    );
  });
});
