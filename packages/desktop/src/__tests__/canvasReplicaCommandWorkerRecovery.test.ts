import { describe, expect, it, vi } from "vitest";
import type {
  CanvasCommandIntent,
  CanvasReconnectResponse
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import type { CompleteContentVersion } from "@planweave-ai/collaboration-protocol/content/version";
import {
  applyCanvasReplicaIntent,
  encodeCanvasReplicaDocument,
  parseCanvasReplicaDocument,
  type CanvasReplicaDocument
} from "@planweave-ai/runtime";
import { basicManifest } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import {
  CanvasReplicaCommandWorker,
  type CanvasReplicaCommandTransport
} from "../main/collaboration/CanvasReplicaCommandWorker.js";
import {
  CanvasReplicaStore,
  type CanvasReplicaScope
} from "../main/collaboration/CanvasReplicaStore.js";

function documentFixture(): CanvasReplicaDocument {
  const manifest = basicManifest({ includeSecondTask: true });
  return parseCanvasReplicaDocument({
    schemaVersion: "canvas-replica-document/v1",
    manifest,
    promptMarkdownByPath: Object.fromEntries(
      manifest.nodes.flatMap((task) => [
        [task.prompt, `# ${task.id} task\n`],
        ...task.blocks.map((block) => [block.prompt, `# ${task.id} ${block.id}\n`])
      ])
    ),
    layout: {
      version: "desktop-layout/v1",
      projectId: "project-authority",
      nodes: [
        { nodeId: "T-001", x: 10, y: 20 },
        { nodeId: "T-002", x: 30, y: 40 }
      ],
      updatedAt: "2026-08-02T00:00:00.000Z"
    }
  });
}

const baseScope: CanvasReplicaScope = {
  authorityId: "authority-a",
  localProjectId: "local-project",
  localCanvasId: "local-canvas",
  projectId: "project-authority",
  canvasId: "default",
  workspaceId: "workspace-authority"
};

function layoutIntent(x: number, updatedAt: string): CanvasCommandIntent {
  return {
    kind: "update_layout",
    nodes: [
      { nodeId: "T-001", x, y: 20 },
      { nodeId: "T-002", x: 30, y: 40 }
    ],
    updatedAt
  };
}

function snapshotResponse(
  content: CompleteContentVersion,
  revision: number
): Extract<CanvasReconnectResponse, { type: "canvas.reconnect.snapshot" }> {
  return {
    type: "canvas.reconnect.snapshot",
    protocolVersion: 1,
    schemaVersion: "canvas-command/v1",
    scope: {
      workspaceId: baseScope.workspaceId,
      projectId: baseScope.projectId,
      canvasId: baseScope.canvasId
    },
    reason: "truncated_journal",
    afterRevision: 0,
    snapshot: {
      metadata: {
        schemaVersion: "canvas-snapshot/v2",
        scope: {
          workspaceId: baseScope.workspaceId,
          projectId: baseScope.projectId,
          canvasId: baseScope.canvasId
        },
        revision,
        contentDigest: content.canonicalDigest,
        createdAt: "2026-08-02T00:00:00.000Z",
        sizeBytes: content.totalBytes
      },
      encoding: "content_version_ref",
      content: {
        versionId: `version-${content.canonicalDigest}`,
        canonicalDigest: content.canonicalDigest,
        verification: "complete"
      }
    }
  };
}

type Gate = {
  promise: Promise<void>;
  resolve: () => void;
};

function createGate(): Gate {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Race a promise against a timeout; always clear the losing timer. */
async function settleOrTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("CanvasReplicaCommandWorker recovery", () => {
  it("settles same-lane stale recovery after uncertain → rebase-drop → confirm without serial deadlock", async () => {
    // Exact self-lock chain that previously hung forever:
    // transport throw → reconcileUncertain (serial) → wasDropped → confirmDropped
    // → stale_revision → recoverStaleRevisionInLane (must NOT re-enter enqueueSerial).
    const document = documentFixture();
    let committedDoc = document;
    let commandRevision = 1;
    let content = encodeCanvasReplicaDocument(committedDoc);
    const store = new CanvasReplicaStore(() => undefined);
    const intent = layoutIntent(9, "2026-08-02T16:00:00.000Z");
    const events: string[] = [];
    let submitCount = 0;
    let reconnectCount = 0;
    let forceRebaseDrop = false;

    const originalReplace = store.replaceFromReconnect.bind(store);
    vi.spyOn(store, "replaceFromReconnect").mockImplementation((input) => {
      const result = originalReplace(input);
      // First uncertain reconnect: report wasDropped while leaving content re-applicable so
      // confirmDropped can re-enqueue and reach recoverStaleRevisionInLane (the nested path).
      if (!forceRebaseDrop) return result;
      forceRebaseDrop = false;
      const operationId = store.pendingOperationIds(baseScope)[0];
      if (!operationId) return result;
      store.acknowledgeIncluded(baseScope, operationId);
      events.push("rebase-drop");
      return {
        droppedPending: [{ operationId, intent }, ...result.droppedPending]
      };
    });

    const transport: CanvasReplicaCommandTransport = {
      async fetchReconnectBaseline() {
        return { response: snapshotResponse(content, commandRevision), content };
      },
      async reconnect(_scope, input) {
        reconnectCount += 1;
        events.push(`reconnect:${reconnectCount}:after=${input.afterRevision}`);
        if (input.afterRevision === 0) {
          return {
            response: snapshotResponse(content, commandRevision),
            snapshotContent: content
          };
        }
        // Peer advances once so confirm sees a newer authoritative head (stale).
        if (reconnectCount === 1) {
          const peerIntent = layoutIntent(50, "2026-08-02T16:00:01.000Z");
          const nextDoc = applyCanvasReplicaIntent(committedDoc, peerIntent);
          const nextContent = encodeCanvasReplicaDocument(nextDoc);
          const previousRevision = commandRevision;
          committedDoc = nextDoc;
          content = nextContent;
          commandRevision += 1;
          return {
            response: {
              type: "canvas.reconnect.delta",
              protocolVersion: 1,
              schemaVersion: "canvas-command/v1",
              scope: {
                workspaceId: baseScope.workspaceId,
                projectId: baseScope.projectId,
                canvasId: baseScope.canvasId
              },
              afterRevision: previousRevision,
              headRevision: commandRevision,
              headContentDigest: content.canonicalDigest,
              entries: [
                {
                  schemaVersion: "canvas-journal/v1" as const,
                  entryId: "journal-peer-same-lane",
                  scope: {
                    workspaceId: baseScope.workspaceId,
                    projectId: baseScope.projectId,
                    canvasId: baseScope.canvasId
                  },
                  revision: commandRevision,
                  previousRevision,
                  operationId: "op-peer-same-lane",
                  intent: peerIntent,
                  intentDigest: "c".repeat(64),
                  contentDigest: nextContent.canonicalDigest,
                  actor: { kind: "human" as const, id: "human-2", displayName: "Peer" },
                  acceptedAt: "2026-08-02T16:00:01.000Z"
                }
              ]
            }
          };
        }
        // same-lane recovery reconnect: empty delta at current head.
        return {
          response: {
            type: "canvas.reconnect.delta",
            protocolVersion: 1,
            schemaVersion: "canvas-command/v1",
            scope: {
              workspaceId: baseScope.workspaceId,
              projectId: baseScope.projectId,
              canvasId: baseScope.canvasId
            },
            afterRevision: input.afterRevision,
            headRevision: commandRevision,
            headContentDigest: content.canonicalDigest,
            entries: []
          }
        };
      },
      async canPersistCanvasCommand() {
        return true;
      },
      async submit(input) {
        submitCount += 1;
        if (submitCount === 1) {
          events.push("uncertain");
          forceRebaseDrop = true;
          throw new Error("socket hang up");
        }
        if (submitCount === 2) {
          // confirmDroppedOrRetryInLane after wasDropped
          events.push("confirm-stale");
          return {
            type: "canvas.command.rejected",
            protocolVersion: 1,
            schemaVersion: "canvas-command/v1",
            projectId: baseScope.projectId,
            canvasId: baseScope.canvasId,
            operationId: input.operationId,
            code: "stale_revision",
            conflict: {
              expectedRevision: input.expectedRevision,
              authoritativeRevision: commandRevision + 1,
              authoritativeContentDigest: content.canonicalDigest
            }
          };
        }
        events.push("accept-after-recovery");
        const nextDoc = applyCanvasReplicaIntent(committedDoc, input.intent);
        const nextContent = encodeCanvasReplicaDocument(nextDoc);
        committedDoc = nextDoc;
        content = nextContent;
        commandRevision += 1;
        return {
          type: "canvas.command.accepted",
          protocolVersion: 1,
          schemaVersion: "canvas-command/v1",
          scope: {
            workspaceId: baseScope.workspaceId,
            projectId: baseScope.projectId,
            canvasId: baseScope.canvasId
          },
          operationId: input.operationId,
          revision: commandRevision,
          previousRevision: commandRevision - 1,
          contentDigest: nextContent.canonicalDigest,
          journalEntryId: `journal-${commandRevision}`,
          actor: { kind: "human", id: "human-1", displayName: "Editor" },
          acceptedAt: "2026-08-02T16:00:02.000Z",
          idempotentReplay: false
        };
      }
    };

    const worker = new CanvasReplicaCommandWorker(store, transport, {
      random: () => 0,
      backoff: { initialDelayMs: 1, maxDelayMs: 1 },
      sleep: async () => undefined
    });
    await worker.bind(baseScope);

    const pending = worker.submit(baseScope, intent);
    // Nested enqueueSerial self-lock would hang forever; bound wait proves settle.
    const outcome = await settleOrTimeout(pending, 2000, "same-lane recovery deadlock/timeout");

    expect(outcome.type).toBe("canvas.command.accepted");
    expect(events).toEqual(
      expect.arrayContaining(["uncertain", "rebase-drop", "confirm-stale", "accept-after-recovery"])
    );
    // uncertain reconnect + same-lane recoverStaleRevisionInLane reconnect (+ optional retries)
    expect(reconnectCount).toBeGreaterThanOrEqual(2);
    expect(submitCount).toBeGreaterThanOrEqual(3);
    expect(store.pendingOperationIds(baseScope)).toEqual([]);
    expect(store.revision(baseScope)).toBeGreaterThanOrEqual(2);
  });

  it("recovers from stale_revision then accepts with the new revision", async () => {
    const document = documentFixture();
    let committedDoc = document;
    let commandRevision = 2;
    let content = encodeCanvasReplicaDocument(committedDoc);
    const store = new CanvasReplicaStore(() => undefined);
    const submitCalls: number[] = [];
    const gates: Gate[] = [];
    let attempt = 0;

    const transport: CanvasReplicaCommandTransport = {
      async fetchReconnectBaseline() {
        return { response: snapshotResponse(content, commandRevision), content };
      },
      async reconnect(_scope, input) {
        const peerIntent = layoutIntent(50, "2026-08-02T07:00:00.000Z");
        const nextDoc = applyCanvasReplicaIntent(committedDoc, peerIntent);
        const nextContent = encodeCanvasReplicaDocument(nextDoc);
        const entry = {
          schemaVersion: "canvas-journal/v1" as const,
          entryId: "journal-peer",
          scope: {
            workspaceId: baseScope.workspaceId,
            projectId: baseScope.projectId,
            canvasId: baseScope.canvasId
          },
          revision: commandRevision + 1,
          previousRevision: commandRevision,
          operationId: "op-peer",
          intent: peerIntent,
          intentDigest: "c".repeat(64),
          contentDigest: nextContent.canonicalDigest,
          actor: { kind: "human" as const, id: "human-2", displayName: "Peer" },
          acceptedAt: "2026-08-02T07:00:00.000Z"
        };
        // only advance when afterRevision matches committed
        if (input.afterRevision === commandRevision) {
          committedDoc = nextDoc;
          content = nextContent;
          commandRevision += 1;
          return {
            response: {
              type: "canvas.reconnect.delta",
              protocolVersion: 1,
              schemaVersion: "canvas-command/v1",
              scope: entry.scope,
              afterRevision: entry.previousRevision,
              headRevision: commandRevision,
              headContentDigest: content.canonicalDigest,
              entries: [entry]
            }
          };
        }
        return {
          response: {
            type: "canvas.reconnect.delta",
            protocolVersion: 1,
            schemaVersion: "canvas-command/v1",
            scope: entry.scope,
            afterRevision: input.afterRevision,
            headRevision: commandRevision,
            headContentDigest: content.canonicalDigest,
            entries: []
          }
        };
      },
      async canPersistCanvasCommand() {
        return true;
      },
      async submit(input) {
        submitCalls.push(input.expectedRevision);
        const gate = createGate();
        gates.push(gate);
        await gate.promise;
        attempt += 1;
        if (attempt === 1) {
          return {
            type: "canvas.command.rejected",
            protocolVersion: 1,
            schemaVersion: "canvas-command/v1",
            projectId: baseScope.projectId,
            canvasId: baseScope.canvasId,
            operationId: input.operationId,
            code: "stale_revision",
            conflict: {
              expectedRevision: input.expectedRevision,
              authoritativeRevision: commandRevision + 1,
              authoritativeContentDigest: "b".repeat(64)
            }
          };
        }
        const nextDoc = applyCanvasReplicaIntent(committedDoc, input.intent);
        const nextContent = encodeCanvasReplicaDocument(nextDoc);
        committedDoc = nextDoc;
        content = nextContent;
        commandRevision += 1;
        return {
          type: "canvas.command.accepted",
          protocolVersion: 1,
          schemaVersion: "canvas-command/v1",
          scope: {
            workspaceId: baseScope.workspaceId,
            projectId: baseScope.projectId,
            canvasId: baseScope.canvasId
          },
          operationId: input.operationId,
          revision: commandRevision,
          previousRevision: commandRevision - 1,
          contentDigest: nextContent.canonicalDigest,
          journalEntryId: `journal-${commandRevision}`,
          actor: { kind: "human", id: "human-1", displayName: "Editor" },
          acceptedAt: "2026-08-02T07:01:00.000Z",
          idempotentReplay: false
        };
      }
    };

    const worker = new CanvasReplicaCommandWorker(store, transport);
    await worker.bind(baseScope);
    const pending = worker.submit(baseScope, layoutIntent(9, "2026-08-02T07:02:00.000Z"));
    await vi.waitFor(() => expect(gates.length).toBe(1));
    gates[0]!.resolve();
    await vi.waitFor(() => expect(gates.length).toBe(2));
    expect(submitCalls).toEqual([2, 3]);
    gates[1]!.resolve();
    const outcome = await pending;
    expect(outcome.type).toBe("canvas.command.accepted");
    expect(store.revision(baseScope)).toBe(4);
  });

  it("rejects promises when pending ops are dropped by rebase", async () => {
    const document = documentFixture();
    let committedDoc = document;
    let commandRevision = 1;
    let content = encodeCanvasReplicaDocument(committedDoc);
    const store = new CanvasReplicaStore(() => undefined);
    const gates: Gate[] = [];
    let attempt = 0;
    const transport: CanvasReplicaCommandTransport = {
      async fetchReconnectBaseline() {
        return { response: snapshotResponse(content, commandRevision), content };
      },
      async reconnect() {
        // Peer removed T-002 so our pending prompt update can no longer apply.
        const peerIntent: CanvasCommandIntent = { kind: "remove_task", taskId: "T-002" };
        const nextDoc = applyCanvasReplicaIntent(committedDoc, peerIntent);
        const nextContent = encodeCanvasReplicaDocument(nextDoc);
        const entry = {
          schemaVersion: "canvas-journal/v1" as const,
          entryId: "journal-peer",
          scope: {
            workspaceId: baseScope.workspaceId,
            projectId: baseScope.projectId,
            canvasId: baseScope.canvasId
          },
          revision: commandRevision + 1,
          previousRevision: commandRevision,
          operationId: "op-peer",
          intent: peerIntent,
          intentDigest: "c".repeat(64),
          contentDigest: nextContent.canonicalDigest,
          actor: { kind: "human" as const, id: "human-2", displayName: "Peer" },
          acceptedAt: "2026-08-02T10:00:00.000Z"
        };
        committedDoc = nextDoc;
        content = nextContent;
        commandRevision += 1;
        return {
          response: {
            type: "canvas.reconnect.delta",
            protocolVersion: 1,
            schemaVersion: "canvas-command/v1",
            scope: entry.scope,
            afterRevision: entry.previousRevision,
            headRevision: commandRevision,
            headContentDigest: content.canonicalDigest,
            entries: [entry]
          }
        };
      },
      async canPersistCanvasCommand() {
        return true;
      },
      async submit(input) {
        const gate = createGate();
        gates.push(gate);
        await gate.promise;
        attempt += 1;
        if (attempt === 1) {
          // Force stale so worker reconnects and rebases pending against remove_task.
          return {
            type: "canvas.command.rejected",
            protocolVersion: 1,
            schemaVersion: "canvas-command/v1",
            projectId: baseScope.projectId,
            canvasId: baseScope.canvasId,
            operationId: input.operationId,
            code: "stale_revision",
            conflict: {
              expectedRevision: input.expectedRevision,
              authoritativeRevision: commandRevision + 1,
              authoritativeContentDigest: "b".repeat(64)
            }
          };
        }
        throw new Error("should not submit dropped op");
      }
    };
    const worker = new CanvasReplicaCommandWorker(store, transport);
    await worker.bind(baseScope);
    const bad = worker.submit(baseScope, {
      kind: "update_task_prompt",
      taskId: "T-002",
      promptMarkdown: "# local edit of second task\n"
    });
    await vi.waitFor(() => expect(gates.length).toBe(1));
    gates[0]!.resolve();
    await expect(bad).rejects.toMatchObject({ code: "canvas_replica_pending_rebase_failed" });
    expect(store.pendingOperationIds(baseScope)).toEqual([]);
  });

  it("keeps the same operationId after transport failure until reconnect confirms acceptance", async () => {
    const document = documentFixture();
    let committedDoc = document;
    let commandRevision = 1;
    let content = encodeCanvasReplicaDocument(committedDoc);
    const store = new CanvasReplicaStore(() => undefined);
    const submitOperationIds: string[] = [];
    let attempt = 0;
    const transport: CanvasReplicaCommandTransport = {
      async fetchReconnectBaseline() {
        return { response: snapshotResponse(content, commandRevision), content };
      },
      async reconnect() {
        // Server actually accepted the first submit before the client saw the timeout.
        const peerIntent = layoutIntent(9, "2026-08-02T12:00:00.000Z");
        // Use the pending intent that was submitted — recovered from last submit call.
        const acceptedId = submitOperationIds[0]!;
        const nextDoc = applyCanvasReplicaIntent(committedDoc, peerIntent);
        const nextContent = encodeCanvasReplicaDocument(nextDoc);
        const entry = {
          schemaVersion: "canvas-journal/v1" as const,
          entryId: "journal-server",
          scope: {
            workspaceId: baseScope.workspaceId,
            projectId: baseScope.projectId,
            canvasId: baseScope.canvasId
          },
          revision: commandRevision + 1,
          previousRevision: commandRevision,
          operationId: acceptedId,
          intent: peerIntent,
          intentDigest: "c".repeat(64),
          contentDigest: nextContent.canonicalDigest,
          actor: { kind: "human" as const, id: "human-1", displayName: "Editor" },
          acceptedAt: "2026-08-02T12:00:00.000Z"
        };
        committedDoc = nextDoc;
        content = nextContent;
        commandRevision += 1;
        return {
          response: {
            type: "canvas.reconnect.delta",
            protocolVersion: 1,
            schemaVersion: "canvas-command/v1",
            scope: entry.scope,
            afterRevision: entry.previousRevision,
            headRevision: commandRevision,
            headContentDigest: content.canonicalDigest,
            entries: [entry]
          }
        };
      },
      async canPersistCanvasCommand() {
        return true;
      },
      async submit(input) {
        submitOperationIds.push(input.operationId);
        attempt += 1;
        if (attempt === 1) {
          // Client times out; Server may already have applied the command.
          throw new Error("socket hang up");
        }
        throw new Error("should not resubmit after journal confirmed acceptance");
      }
    };
    const worker = new CanvasReplicaCommandWorker(store, transport);
    await worker.bind(baseScope);
    const pending = worker.submit(baseScope, layoutIntent(9, "2026-08-02T12:00:00.000Z"));
    const outcome = await pending;
    expect(outcome.type).toBe("canvas.command.accepted");
    expect(outcome.operationId).toBe(submitOperationIds[0]);
    expect(store.revision(baseScope)).toBe(2);
    expect(store.pendingOperationIds(baseScope)).toEqual([]);
    expect(attempt).toBe(1);
  });

  it("resubmits the same operationId after transport failure when reconnect finds no acceptance", async () => {
    const document = documentFixture();
    let committedDoc = document;
    let commandRevision = 1;
    let content = encodeCanvasReplicaDocument(committedDoc);
    const store = new CanvasReplicaStore(() => undefined);
    const submitOperationIds: string[] = [];
    let attempt = 0;
    const transport: CanvasReplicaCommandTransport = {
      async fetchReconnectBaseline() {
        return { response: snapshotResponse(content, commandRevision), content };
      },
      async reconnect() {
        return {
          response: {
            type: "canvas.reconnect.delta",
            protocolVersion: 1,
            schemaVersion: "canvas-command/v1",
            scope: {
              workspaceId: baseScope.workspaceId,
              projectId: baseScope.projectId,
              canvasId: baseScope.canvasId
            },
            afterRevision: commandRevision,
            headRevision: commandRevision,
            headContentDigest: content.canonicalDigest,
            entries: []
          }
        };
      },
      async canPersistCanvasCommand() {
        return true;
      },
      async submit(input) {
        submitOperationIds.push(input.operationId);
        attempt += 1;
        if (attempt === 1) {
          throw new Error("network timeout");
        }
        const nextDoc = applyCanvasReplicaIntent(committedDoc, input.intent);
        const nextContent = encodeCanvasReplicaDocument(nextDoc);
        committedDoc = nextDoc;
        content = nextContent;
        commandRevision += 1;
        return {
          type: "canvas.command.accepted",
          protocolVersion: 1,
          schemaVersion: "canvas-command/v1",
          scope: {
            workspaceId: baseScope.workspaceId,
            projectId: baseScope.projectId,
            canvasId: baseScope.canvasId
          },
          operationId: input.operationId,
          revision: commandRevision,
          previousRevision: commandRevision - 1,
          contentDigest: nextContent.canonicalDigest,
          journalEntryId: `journal-${commandRevision}`,
          actor: { kind: "human", id: "human-1", displayName: "Editor" },
          acceptedAt: "2026-08-02T12:30:00.000Z",
          idempotentReplay: false
        };
      }
    };
    const worker = new CanvasReplicaCommandWorker(store, transport);
    await worker.bind(baseScope);
    const outcome = await worker.submit(baseScope, layoutIntent(3, "2026-08-02T12:30:00.000Z"));
    expect(outcome.type).toBe("canvas.command.accepted");
    expect(submitOperationIds).toHaveLength(2);
    expect(submitOperationIds[0]).toBe(submitOperationIds[1]);
    expect(store.revision(baseScope)).toBe(2);
  });

  it("applies cancellable exponential backoff under permanent network failure", async () => {
    const document = documentFixture();
    const content = encodeCanvasReplicaDocument(document);
    const store = new CanvasReplicaStore(() => undefined);
    let submitCalls = 0;
    let reconnectCalls = 0;
    const sleepCalls: number[] = [];
    let worker!: CanvasReplicaCommandWorker;
    const transport: CanvasReplicaCommandTransport = {
      async fetchReconnectBaseline() {
        return { response: snapshotResponse(content, 1), content };
      },
      async reconnect() {
        reconnectCalls += 1;
        throw new Error("network offline");
      },
      async canPersistCanvasCommand() {
        return true;
      },
      async submit() {
        submitCalls += 1;
        throw new Error("network offline");
      }
    };
    worker = new CanvasReplicaCommandWorker(store, transport, {
      // Deterministic: zero jitter; sleep records delays and yields so the loop stays bounded.
      random: () => 0,
      backoff: { initialDelayMs: 10, maxDelayMs: 40 },
      sleep: async (ms) => {
        sleepCalls.push(ms);
        // After a few backoff waits, cancel the session (simulates disconnect).
        if (sleepCalls.length >= 3) {
          worker.clear(baseScope);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    });
    await worker.bind(baseScope);
    const pending = worker.submit(baseScope, layoutIntent(1, "2026-08-02T14:00:00.000Z"));

    await expect(pending).rejects.toMatchObject({ code: "canvas_replica_session_disconnected" });
    // Equal-jitter with random=0: floor(cap/2) but at least 1; delays non-decreasing.
    expect(sleepCalls.length).toBe(3);
    expect(sleepCalls[0]).toBeGreaterThanOrEqual(1);
    expect(sleepCalls[1]!).toBeGreaterThanOrEqual(sleepCalls[0]!);
    expect(sleepCalls[2]!).toBeGreaterThanOrEqual(sleepCalls[1]!);
    // Network attempts are gated by backoff — not an unbounded hot loop.
    expect(submitCalls).toBeGreaterThanOrEqual(3);
    expect(submitCalls).toBeLessThanOrEqual(4);
    expect(reconnectCalls).toBeGreaterThanOrEqual(3);
    expect(reconnectCalls).toBeLessThanOrEqual(4);
    const submitsAfterClear = submitCalls;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(submitCalls).toBe(submitsAfterClear);
  });

  it("upgrades to a full snapshot when delta materialization fails after server accept", async () => {
    const document = documentFixture();
    let committedDoc = document;
    let commandRevision = 1;
    let content = encodeCanvasReplicaDocument(committedDoc);
    const publishedDigests: string[] = [];
    const store = new CanvasReplicaStore((projection) => {
      publishedDigests.push(projection.contentDigest);
    });
    const intent = layoutIntent(42, "2026-08-02T15:00:00.000Z");
    const nextDoc = applyCanvasReplicaIntent(committedDoc, intent);
    const nextContent = encodeCanvasReplicaDocument(nextDoc);
    const badDigest = "f".repeat(64);
    const reconnectAfterRevisions: number[] = [];

    const transport: CanvasReplicaCommandTransport = {
      async fetchReconnectBaseline() {
        return { response: snapshotResponse(content, commandRevision), content };
      },
      async reconnect(_scope, input) {
        reconnectAfterRevisions.push(input.afterRevision);
        if (input.afterRevision === 0) {
          // Full snapshot at the post-accept head (only after bad delta fails).
          committedDoc = nextDoc;
          content = nextContent;
          commandRevision = 2;
          return {
            response: snapshotResponse(content, commandRevision),
            snapshotContent: content
          };
        }
        // Delta claims a digest that cannot be produced by replaying the intent.
        return {
          response: {
            type: "canvas.reconnect.delta",
            protocolVersion: 1,
            schemaVersion: "canvas-command/v1",
            scope: {
              workspaceId: baseScope.workspaceId,
              projectId: baseScope.projectId,
              canvasId: baseScope.canvasId
            },
            afterRevision: 1,
            headRevision: 2,
            headContentDigest: badDigest,
            entries: [
              {
                schemaVersion: "canvas-journal/v1",
                entryId: "journal-bad-digest",
                scope: {
                  workspaceId: baseScope.workspaceId,
                  projectId: baseScope.projectId,
                  canvasId: baseScope.canvasId
                },
                revision: 2,
                previousRevision: 1,
                operationId: "will-be-replaced",
                intent,
                intentDigest: "c".repeat(64),
                contentDigest: badDigest,
                actor: { kind: "human", id: "human-1", displayName: "Editor" },
                acceptedAt: "2026-08-02T15:00:00.000Z"
              }
            ]
          }
        };
      },
      async canPersistCanvasCommand() {
        return true;
      },
      async submit(input) {
        // Server accepted, but local fold fails (outcome digest cannot be reproduced).
        committedDoc = nextDoc;
        content = nextContent;
        commandRevision = 2;
        return {
          type: "canvas.command.accepted",
          protocolVersion: 1,
          schemaVersion: "canvas-command/v1",
          scope: {
            workspaceId: baseScope.workspaceId,
            projectId: baseScope.projectId,
            canvasId: baseScope.canvasId
          },
          operationId: input.operationId,
          revision: 2,
          previousRevision: 1,
          contentDigest: badDigest,
          journalEntryId: "journal-2",
          actor: { kind: "human", id: "human-1", displayName: "Editor" },
          acceptedAt: "2026-08-02T15:00:00.000Z",
          idempotentReplay: false
        };
      }
    };

    const worker = new CanvasReplicaCommandWorker(store, transport, {
      random: () => 0,
      backoff: { initialDelayMs: 1, maxDelayMs: 1 },
      sleep: async () => undefined
    });
    await worker.bind(baseScope);
    const baselineDigest = store.digest(baseScope)!;
    const digestsAfterBind = [...publishedDigests];

    const outcome = await worker.submit(baseScope, intent);
    expect(outcome.type).toBe("canvas.command.accepted");
    // Must try delta at current revision, then upgrade to snapshot at 0.
    expect(reconnectAfterRevisions).toEqual([1, 0]);
    // Bad delta digest must never become the published committed head.
    expect(publishedDigests).not.toContain(badDigest);
    expect(store.revision(baseScope)).toBe(2);
    expect(store.digest(baseScope)).toBe(nextContent.canonicalDigest);
    expect(store.pendingOperationIds(baseScope)).toEqual([]);
    // Snapshot is the first publish that advances committed digest past baseline.
    const afterBind = publishedDigests.slice(digestsAfterBind.length);
    expect(afterBind.some((digest) => digest === nextContent.canonicalDigest)).toBe(true);
    expect(store.digest(baseScope)).not.toBe(baselineDigest);
  });

  it("clears pending when idempotent accept reports the current head revision", async () => {
    const document = documentFixture();
    let committedDoc = document;
    let commandRevision = 1;
    let content = encodeCanvasReplicaDocument(committedDoc);
    const store = new CanvasReplicaStore(() => undefined);
    const intent = layoutIntent(7, "2026-08-02T16:00:00.000Z");
    // Snapshot head already includes the operation.
    const headDoc = applyCanvasReplicaIntent(committedDoc, intent);
    const headContent = encodeCanvasReplicaDocument(headDoc);
    committedDoc = headDoc;
    content = headContent;
    commandRevision = 2;

    const transport: CanvasReplicaCommandTransport = {
      async fetchReconnectBaseline() {
        return { response: snapshotResponse(content, commandRevision), content };
      },
      async reconnect() {
        return {
          response: {
            type: "canvas.reconnect.delta",
            protocolVersion: 1,
            schemaVersion: "canvas-command/v1",
            scope: {
              workspaceId: baseScope.workspaceId,
              projectId: baseScope.projectId,
              canvasId: baseScope.canvasId
            },
            afterRevision: commandRevision,
            headRevision: commandRevision,
            headContentDigest: content.canonicalDigest,
            entries: []
          }
        };
      },
      async canPersistCanvasCommand() {
        return true;
      },
      async submit(input) {
        return {
          type: "canvas.command.accepted",
          protocolVersion: 1,
          schemaVersion: "canvas-command/v1",
          scope: {
            workspaceId: baseScope.workspaceId,
            projectId: baseScope.projectId,
            canvasId: baseScope.canvasId
          },
          operationId: input.operationId,
          revision: commandRevision,
          previousRevision: commandRevision - 1,
          contentDigest: content.canonicalDigest,
          journalEntryId: "journal-idempotent",
          actor: { kind: "human", id: "human-1", displayName: "Editor" },
          acceptedAt: "2026-08-02T16:00:00.000Z",
          idempotentReplay: true
        };
      }
    };

    const worker = new CanvasReplicaCommandWorker(store, transport);
    await worker.bind(baseScope);
    // Pending is a second optimistic apply of the same layout (already on head).
    const outcome = await worker.submit(baseScope, intent);
    expect(outcome.type).toBe("canvas.command.accepted");
    expect(store.revision(baseScope)).toBe(2);
    expect(store.pendingOperationIds(baseScope)).toEqual([]);
  });
});
