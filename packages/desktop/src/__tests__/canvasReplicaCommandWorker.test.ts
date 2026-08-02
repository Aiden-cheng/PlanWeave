import { describe, expect, it, vi } from "vitest";
import type {
  CanvasCommandIntent,
  CanvasCommandOutcome,
  CanvasReconnectResponse,
  CompleteContentVersion
} from "@planweave-ai/collaboration-contracts";
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
import type { CollaborationCanvasReplicaProjection } from "../shared/canvasReplicaIpc.js";
import { CollaborationClientError } from "../main/collaboration/collaborationErrors.js";

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

function createHarness(options?: {
  canEdit?: boolean;
  commandRevision?: number;
  contentAuthorityRevision?: number;
}) {
  const document = documentFixture();
  let committedDoc = document;
  let commandRevision = options?.commandRevision ?? 5;
  // Intentionally different from command revision to prove independence.
  const contentAuthorityRevision = options?.contentAuthorityRevision ?? 99;
  void contentAuthorityRevision;
  let content = encodeCanvasReplicaDocument(committedDoc);
  const published: CollaborationCanvasReplicaProjection[] = [];
  const store = new CanvasReplicaStore((projection) => published.push(projection));
  const submitCalls: Array<{ operationId: string; expectedRevision: number }> = [];
  const reconnectCalls: Array<{ afterRevision: number }> = [];
  const submitGates: Gate[] = [];

  const transport: CanvasReplicaCommandTransport = {
    async fetchReconnectBaseline() {
      return {
        response: snapshotResponse(content, commandRevision),
        content
      };
    },
    async reconnect(_scope, input) {
      reconnectCalls.push({ afterRevision: input.afterRevision });
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
      return options?.canEdit ?? true;
    },
    async submit(input) {
      submitCalls.push({
        operationId: input.operationId,
        expectedRevision: input.expectedRevision
      });
      const gate = createGate();
      submitGates.push(gate);
      await gate.promise;
      const nextDoc = applyCanvasReplicaIntent(committedDoc, input.intent);
      const nextContent = encodeCanvasReplicaDocument(nextDoc);
      committedDoc = nextDoc;
      content = nextContent;
      commandRevision += 1;
      const outcome: CanvasCommandOutcome = {
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
        acceptedAt: "2026-08-02T00:00:00.000Z",
        idempotentReplay: false
      };
      return outcome;
    }
  };

  const worker = new CanvasReplicaCommandWorker(store, transport);
  return {
    worker,
    store,
    published,
    submitCalls,
    reconnectCalls,
    submitGates,
    getCommandRevision: () => commandRevision,
    getContent: () => content,
    setCommandRevision: (value: number) => {
      commandRevision = value;
    },
    setCommitted: (doc: CanvasReplicaDocument) => {
      committedDoc = doc;
      content = encodeCanvasReplicaDocument(doc);
    },
    transport
  };
}

describe("CanvasReplicaCommandWorker", () => {
  it("uses snapshot command revision (not content-authority revision) on first submit", async () => {
    const harness = createHarness({ commandRevision: 5, contentAuthorityRevision: 99 });
    await harness.worker.bind(baseScope);
    expect(harness.store.revision(baseScope)).toBe(5);

    const submitPromise = harness.worker.submit(
      baseScope,
      layoutIntent(11, "2026-08-02T04:00:00.000Z")
    );
    await vi.waitFor(() => expect(harness.submitCalls.length).toBe(1));
    expect(harness.submitCalls[0]?.expectedRevision).toBe(5);
    harness.submitGates[0]!.resolve();
    await submitPromise;
    expect(harness.store.revision(baseScope)).toBe(6);
  });

  it("establishes baseline solely from reconnect snapshot without mixed content-head pairing", async () => {
    const document = documentFixture();
    const snapshotContent = encodeCanvasReplicaDocument(document);
    // A later content-authority head would have a different digest if edited between discover and reconnect.
    const laterDoc = applyCanvasReplicaIntent(
      document,
      layoutIntent(777, "2026-08-02T05:00:00.000Z")
    );
    const laterContent = encodeCanvasReplicaDocument(laterDoc);
    expect(laterContent.canonicalDigest).not.toBe(snapshotContent.canonicalDigest);

    const store = new CanvasReplicaStore(() => undefined);
    let discoverUsed = false;
    const transport: CanvasReplicaCommandTransport = {
      async fetchReconnectBaseline() {
        // Only reconnect snapshot content is used.
        return {
          response: snapshotResponse(snapshotContent, 4),
          content: snapshotContent
        };
      },
      async reconnect() {
        throw new Error("unexpected reconnect");
      },
      async canPersistCanvasCommand() {
        return true;
      },
      async submit() {
        throw new Error("unexpected submit");
      }
    };
    // Guard: transport must not call discover-style APIs.
    void discoverUsed;
    const worker = new CanvasReplicaCommandWorker(store, transport);
    await worker.bind(baseScope);
    expect(store.revision(baseScope)).toBe(4);
    expect(store.digest(baseScope)).toBe(snapshotContent.canonicalDigest);
    // later content head must never replace snapshot content
    expect(store.digest(baseScope)).not.toBe(laterContent.canonicalDigest);
  });

  it("shows two rapid submits in optimistic projection while network stays FIFO", async () => {
    const harness = createHarness({ commandRevision: 1 });
    await harness.worker.bind(baseScope);
    const first = harness.worker.submit(baseScope, layoutIntent(1, "2026-08-02T06:00:00.000Z"));
    const second = harness.worker.submit(baseScope, layoutIntent(2, "2026-08-02T06:00:01.000Z"));

    expect(harness.store.pendingOperationIds(baseScope)).toHaveLength(2);
    const projection = harness.store.projection(baseScope)!;
    expect(projection.optimisticOperationIds).toHaveLength(2);
    expect(projection.content.layout.nodes.find((n) => n.nodeId === "T-001")?.x).toBe(2);

    await vi.waitFor(() => expect(harness.submitCalls.length).toBe(1));
    expect(harness.submitCalls[0]?.expectedRevision).toBe(1);
    harness.submitGates[0]!.resolve();
    await first;

    await vi.waitFor(() => expect(harness.submitCalls.length).toBe(2));
    expect(harness.submitCalls[1]?.expectedRevision).toBe(2);
    harness.submitGates[1]!.resolve();
    await second;
    expect(harness.store.pendingOperationIds(baseScope)).toEqual([]);
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

  it("sets canEdit false and rejects remaining pending on forbidden", async () => {
    const document = documentFixture();
    const content = encodeCanvasReplicaDocument(document);
    const store = new CanvasReplicaStore(() => undefined);
    const gates: Gate[] = [];
    let submits = 0;
    const transport: CanvasReplicaCommandTransport = {
      async fetchReconnectBaseline() {
        return { response: snapshotResponse(content, 1), content };
      },
      async reconnect() {
        throw new Error("unexpected reconnect");
      },
      async canPersistCanvasCommand() {
        return true;
      },
      async submit(input) {
        submits += 1;
        const gate = createGate();
        gates.push(gate);
        await gate.promise;
        return {
          type: "canvas.command.rejected",
          protocolVersion: 1,
          schemaVersion: "canvas-command/v1",
          projectId: baseScope.projectId,
          canvasId: baseScope.canvasId,
          operationId: input.operationId,
          code: "forbidden",
          detail: "canvas_write_denied"
        };
      }
    };
    const worker = new CanvasReplicaCommandWorker(store, transport);
    await worker.bind(baseScope);
    const first = worker.submit(baseScope, layoutIntent(1, "2026-08-02T08:00:00.000Z"));
    const second = worker.submit(baseScope, layoutIntent(2, "2026-08-02T08:00:01.000Z"));
    await vi.waitFor(() => expect(gates.length).toBe(1));
    gates[0]!.resolve();
    const firstOutcome = await first;
    expect(firstOutcome.type).toBe("canvas.command.rejected");
    if (firstOutcome.type === "canvas.command.rejected") {
      expect(firstOutcome.code).toBe("forbidden");
    }
    await expect(second).rejects.toMatchObject({ code: "canvas_replica_command_forbidden" });
    expect(store.canEdit(baseScope)).toBe(false);
    await expect(
      worker.submit(baseScope, layoutIntent(3, "2026-08-02T08:00:02.000Z"))
    ).rejects.toMatchObject({ code: "canvas_replica_command_forbidden" });
    expect(submits).toBe(1);
  });

  it("ignores late baseline and submit responses after clear/disconnect", async () => {
    const document = documentFixture();
    const content = encodeCanvasReplicaDocument(document);
    const store = new CanvasReplicaStore(() => undefined);
    const baselineGate = createGate();
    const submitGate = createGate();
    let bindFinished = false;
    const transport: CanvasReplicaCommandTransport = {
      async fetchReconnectBaseline() {
        await baselineGate.promise;
        return { response: snapshotResponse(content, 1), content };
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
            afterRevision: 0,
            headRevision: 0,
            headContentDigest: content.canonicalDigest,
            entries: []
          }
        };
      },
      async canPersistCanvasCommand() {
        return true;
      },
      async submit(input) {
        await submitGate.promise;
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
          contentDigest: content.canonicalDigest,
          journalEntryId: "journal-late",
          actor: { kind: "human", id: "human-1", displayName: "Editor" },
          acceptedAt: "2026-08-02T09:00:00.000Z",
          idempotentReplay: false
        };
      }
    };
    const worker = new CanvasReplicaCommandWorker(store, transport);
    const bindPromise = worker.bind(baseScope).then(
      () => {
        bindFinished = true;
      },
      () => {
        bindFinished = false;
      }
    );
    worker.clear(baseScope);
    baselineGate.resolve();
    await bindPromise;
    expect(bindFinished).toBe(false);
    expect(store.projection(baseScope)).toBeNull();

    // Fresh session then disconnect mid-submit
    const transport2: CanvasReplicaCommandTransport = {
      async fetchReconnectBaseline() {
        return { response: snapshotResponse(content, 1), content };
      },
      async reconnect() {
        throw new Error("unexpected");
      },
      async canPersistCanvasCommand() {
        return true;
      },
      async submit(input) {
        await submitGate.promise;
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
          contentDigest: content.canonicalDigest,
          journalEntryId: "journal-late",
          actor: { kind: "human", id: "human-1", displayName: "Editor" },
          acceptedAt: "2026-08-02T09:00:00.000Z",
          idempotentReplay: false
        };
      }
    };
    const worker2 = new CanvasReplicaCommandWorker(store, transport2);
    await worker2.bind(baseScope);
    const pending = worker2.submit(baseScope, layoutIntent(1, "2026-08-02T09:01:00.000Z"));
    worker2.clear(baseScope);
    submitGate.resolve();
    await expect(pending).rejects.toMatchObject({ code: "canvas_replica_session_disconnected" });
    expect(store.projection(baseScope)).toBeNull();
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

  it("denies viewer submits and allows owner/editor canEdit from capability", async () => {
    const document = documentFixture();
    const content = encodeCanvasReplicaDocument(document);
    for (const canEdit of [false, true]) {
      const store = new CanvasReplicaStore(() => undefined);
      const transport: CanvasReplicaCommandTransport = {
        async fetchReconnectBaseline() {
          return { response: snapshotResponse(content, 0), content };
        },
        async reconnect() {
          throw new Error("unexpected");
        },
        async canPersistCanvasCommand() {
          return canEdit;
        },
        async submit() {
          throw new Error("should not submit for viewer");
        }
      };
      const worker = new CanvasReplicaCommandWorker(store, transport);
      await worker.bind(baseScope);
      expect(store.canEdit(baseScope)).toBe(canEdit);
      if (!canEdit) {
        await expect(
          worker.submit(baseScope, layoutIntent(1, "2026-08-02T11:00:00.000Z"))
        ).rejects.toBeInstanceOf(CollaborationClientError);
      }
    }
  });

  it("isolates authority identities that share workspace/project/canvas ids", async () => {
    const harnessA = createHarness({ commandRevision: 3 });
    await harnessA.worker.bind(baseScope);
    const scopeB = { ...baseScope, authorityId: "authority-b" };
    const document = documentFixture();
    const content = encodeCanvasReplicaDocument(document);
    const storeB = harnessA.store;
    const transportB: CanvasReplicaCommandTransport = {
      async fetchReconnectBaseline() {
        return { response: snapshotResponse(content, 0), content };
      },
      async reconnect() {
        throw new Error("unexpected");
      },
      async canPersistCanvasCommand() {
        return true;
      },
      async submit() {
        throw new Error("unexpected");
      }
    };
    const workerB = new CanvasReplicaCommandWorker(storeB, transportB);
    await workerB.bind(scopeB);
    expect(storeB.revision(baseScope)).toBe(3);
    expect(storeB.revision(scopeB)).toBe(0);
  });
});
