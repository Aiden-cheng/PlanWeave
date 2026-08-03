import { describe, expect, it } from "vitest";
import { CANVAS_LIVE_SYNC_PROTOCOL_VERSION } from "../limits.js";
import { exampleCanvasJournalEntry } from "../fixtures/collaboration.js";
import {
  canvasLiveSyncClientMessageSchema,
  canvasLiveSyncServerMessageSchema
} from "../canvasLiveSync.js";

describe("canvas live sync contracts", () => {
  const hello = {
    type: "canvas.live.hello" as const,
    protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
    projectId: "project-1",
    canvasId: "canvas-1",
    lastRevision: 4
  };

  it("accepts only read-only hello and ping client frames", () => {
    expect(canvasLiveSyncClientMessageSchema.parse(hello)).toEqual(hello);
    expect(
      canvasLiveSyncClientMessageSchema.parse({
        type: "canvas.live.ping",
        protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION
      })
    ).toMatchObject({ type: "canvas.live.ping" });
    expect(() =>
      canvasLiveSyncClientMessageSchema.parse({
        ...hello,
        operationId: "op-1",
        intent: { kind: "add_task" }
      })
    ).toThrow();
    expect(() =>
      canvasLiveSyncClientMessageSchema.parse({ ...hello, token: "pw_hdev_secret" })
    ).toThrow();
    expect(() =>
      canvasLiveSyncClientMessageSchema.parse({ ...hello, projectRoot: "/absolute/path" })
    ).toThrow();
  });

  it("delivers complete validated journal entries and explicit HTTP catchup", () => {
    expect(
      canvasLiveSyncServerMessageSchema.parse({
        type: "canvas.live.accepted_entry",
        protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
        entry: exampleCanvasJournalEntry
      })
    ).toMatchObject({ entry: { revision: exampleCanvasJournalEntry.revision } });
    expect(
      canvasLiveSyncServerMessageSchema.parse({
        type: "canvas.live.catchup_required",
        protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
        projectId: "project-1",
        canvasId: "canvas-1",
        reason: "revision_behind",
        recovery: "http_reconnect",
        headRevision: 4,
        headContentDigest: "a".repeat(64)
      })
    ).toMatchObject({ recovery: "http_reconnect" });
    expect(() =>
      canvasLiveSyncServerMessageSchema.parse({
        type: "canvas.live.accepted_entry",
        protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
        entry: { ...exampleCanvasJournalEntry, revision: 9, previousRevision: 3 }
      })
    ).toThrow();
  });
});
