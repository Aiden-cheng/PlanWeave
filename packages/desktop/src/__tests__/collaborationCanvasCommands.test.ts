import { describe, expect, it, vi } from "vitest";
import type { CollaborationClient } from "../main/collaboration/CollaborationClient.js";
import { CollaborationCanvasCommandFacade } from "../main/collaboration/collaborationCanvasCommands.js";
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
      canvasId: "local-canvas"
    });
    expect(bindCanvasCommandSession).toHaveBeenCalledWith("remote-canvas");
  });
});
