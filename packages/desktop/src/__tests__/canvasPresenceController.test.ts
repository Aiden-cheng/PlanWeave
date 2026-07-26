import type { CanvasPresenceServerMessage } from "@planweave-ai/collaboration-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CanvasPresenceController,
  type CanvasPresenceBridge
} from "../renderer/collaboration/CanvasPresenceController";
import type { CollaborationPresenceSignal } from "../shared/collaboration";
import { createTranslator } from "../renderer/i18n";

const labels = (language: "en" | "zh-CN") => {
  const t = createTranslator(language);
  return {
    unknownSession: t("canvasPresenceUnknownSession"),
    unknownMember: t("canvasPresenceUnknownMember"),
    collaborator: t("canvasPresenceCollaborator"),
    error: (code: string) => t("canvasPresenceError").replace("{code}", code)
  };
};

function session(sessionId: string, humanPrincipalId: string, displayName: string) {
  return {
    identity: { sessionId, humanPrincipalId, displayName },
    pointer: { x: 120, y: 240 },
    selectionIds: ["T-001"]
  } as const;
}

function signal(message: CanvasPresenceServerMessage): CollaborationPresenceSignal {
  return { profileId: "profile-1", message };
}

function createBridge() {
  const listeners = new Set<(value: CollaborationPresenceSignal) => void>();
  const bridge: CanvasPresenceBridge = {
    startCollaborationPresence: vi.fn().mockResolvedValue(undefined),
    stopCollaborationPresence: vi.fn().mockResolvedValue(undefined),
    publishCollaborationPresence: vi.fn().mockResolvedValue(undefined),
    onCollaborationPresenceSignal: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    })
  };
  return {
    bridge,
    emit: (value: CollaborationPresenceSignal) => {
      listeners.forEach((listener) => {
        listener(value);
      });
    },
    emitTo: (index: number, value: CollaborationPresenceSignal) => [...listeners][index]?.(value)
  };
}

describe("CanvasPresenceController", () => {
  beforeEach(() => vi.useRealTimers());

  it("keeps two real client read models scoped, sanitized, and remote-only", async () => {
    const transport = createBridge();
    const first = new CanvasPresenceController({ api: transport.bridge, labels: labels("en") });
    const second = new CanvasPresenceController({ api: transport.bridge, labels: labels("en") });
    await first.start({
      profileId: "profile-1",
      canvasId: "canvas-main"
    });
    await second.start({
      profileId: "profile-1",
      canvasId: "canvas-main"
    });

    transport.emitTo(
      0,
      signal({
        type: "canvas.presence.snapshot",
        protocolVersion: 1,
        projectId: "project-1",
        canvasId: "canvas-main",
        sessions: [session("session-b", "human-a", "Bob")]
      })
    );
    transport.emitTo(
      1,
      signal({
        type: "canvas.presence.snapshot",
        protocolVersion: 1,
        projectId: "project-1",
        canvasId: "canvas-main",
        sessions: [session("session-a", "human-a", "  Alice\u0000 ")]
      })
    );

    expect(first.getSnapshot().sessions).toEqual([
      {
        sessionId: "session-b",
        humanPrincipalId: "human-a",
        displayName: "Bob",
        pointer: { x: 120, y: 240 },
        selectionIds: ["T-001"]
      }
    ]);
    expect(second.getSnapshot().sessions).toEqual([
      {
        sessionId: "session-a",
        humanPrincipalId: "human-a",
        displayName: "Alice",
        pointer: { x: 120, y: 240 },
        selectionIds: ["T-001"]
      }
    ]);

    transport.emitTo(
      0,
      signal({
        type: "canvas.presence.leave",
        protocolVersion: 1,
        projectId: "project-1",
        canvasId: "canvas-main",
        sessionId: "session-b"
      })
    );
    expect(first.getSnapshot().sessions).toEqual([]);
    expect(second.getSnapshot().sessions).toHaveLength(1);

    await first.stop();
    expect(first.getSnapshot().sessions).toEqual([]);
  });

  it("keeps a quiet session until the server sends leave and ignores another canvas", async () => {
    const transport = createBridge();
    const controller = new CanvasPresenceController({
      api: transport.bridge,
      labels: labels("zh-CN")
    });
    await controller.start({
      profileId: "profile-1",
      canvasId: "canvas-main"
    });
    const update = (canvasId: string) =>
      signal({
        type: "canvas.presence.update",
        protocolVersion: 1,
        projectId: "project-1",
        canvasId,
        session: session("session-b", "human-b", "Bob")
      });
    transport.emit(update("canvas-other"));
    expect(controller.getSnapshot().sessions).toEqual([]);
    transport.emit(update("canvas-main"));
    expect(controller.getSnapshot().sessions).toHaveLength(1);
    transport.emit({
      profileId: "profile-1",
      reset: { canvasId: "canvas-main", reason: "disconnected" }
    });
    expect(controller.getSnapshot().sessions).toEqual([]);
    transport.emit(update("canvas-main"));
    expect(controller.getSnapshot().sessions).toHaveLength(1);
    transport.emit(
      signal({
        type: "canvas.presence.leave",
        protocolVersion: 1,
        projectId: "project-1",
        canvasId: "canvas-main",
        sessionId: "session-b"
      })
    );
    expect(controller.getSnapshot().sessions).toEqual([]);
    await controller.stop();
  });
});
