import { randomUUID } from "node:crypto";
import type {
  CanvasCommandIntent,
  CanvasCommandOutcome,
  CanvasReconnectResponse,
  CompleteContentVersion
} from "@planweave-ai/collaboration-contracts";
import type {
  CanvasReplicaPendingOperation,
  CanvasReplicaScope
} from "./CanvasReplicaStore.js";
import { CanvasReplicaStore } from "./CanvasReplicaStore.js";
import { CollaborationClientError } from "./collaborationErrors.js";

export type CanvasReplicaCommandTransport = {
  /**
   * First baseline: reconnect(afterRevision: 0) → require snapshot → download
   * only the snapshot's immutable content ref. Never discover a separate content head.
   */
  fetchReconnectBaseline(scope: CanvasReplicaScope): Promise<{
    response: Extract<CanvasReconnectResponse, { type: "canvas.reconnect.snapshot" }>;
    content: CompleteContentVersion;
  }>;
  reconnect(
    scope: CanvasReplicaScope,
    input: { afterRevision: number; afterContentDigest: string | null }
  ): Promise<{
    response: CanvasReconnectResponse;
    snapshotContent?: CompleteContentVersion;
  }>;
  canPersistCanvasCommand(scope: CanvasReplicaScope): Promise<boolean>;
  submit(input: {
    scope: CanvasReplicaScope;
    operationId: string;
    expectedRevision: number;
    intent: CanvasCommandIntent;
  }): Promise<CanvasCommandOutcome>;
};

type Queued = {
  operationId: string;
  intent: CanvasCommandIntent;
  resolve: (outcome: CanvasCommandOutcome) => void;
  reject: (error: Error) => void;
  settled: boolean;
};

function disconnectedError(): CollaborationClientError {
  return new CollaborationClientError({
    kind: "aborted",
    code: "canvas_replica_session_disconnected",
    message: "canvas_replica_session_disconnected",
    retryable: false
  });
}

function forbiddenError(): CollaborationClientError {
  return new CollaborationClientError({
    kind: "forbidden",
    code: "canvas_replica_command_forbidden",
    message: "canvas_replica_command_forbidden",
    retryable: false
  });
}

function settleReject(item: Queued, error: Error): void {
  if (item.settled) return;
  item.settled = true;
  item.reject(error);
}

function settleResolve(item: Queued, outcome: CanvasCommandOutcome): void {
  if (item.settled) return;
  item.settled = true;
  item.resolve(outcome);
}

/**
 * Per-authority-scope FIFO command worker.
 * Renderer never supplies operationId or expectedRevision — both are main-process owned.
 * Optimistic pending is published before any network await; network submits are serial.
 */
export class CanvasReplicaCommandWorker {
  private readonly queues = new Map<string, Queued[]>();
  private readonly running = new Set<string>();
  private readonly generations = new Map<string, number>();
  private readonly scopes = new Map<string, CanvasReplicaScope>();

  constructor(
    private readonly store: CanvasReplicaStore,
    private readonly transport: CanvasReplicaCommandTransport
  ) {}

  async bind(scope: CanvasReplicaScope): Promise<void> {
    const scopeKey = this.key(scope);
    this.bumpGeneration(scopeKey);
    this.rejectQueue(scopeKey, disconnectedError());
    this.store.clear(scope);
    this.store.bind(scope);
    this.scopes.set(scopeKey, scope);

    const generation = this.generations.get(scopeKey) ?? 0;
    const [baseline, canEdit] = await Promise.all([
      this.transport.fetchReconnectBaseline(scope),
      this.transport.canPersistCanvasCommand(scope)
    ]);
    if (!this.isCurrent(scopeKey, generation)) {
      throw disconnectedError();
    }

    const { response, content } = baseline;
    if (
      response.snapshot.metadata.scope.workspaceId !== scope.workspaceId ||
      response.snapshot.metadata.scope.projectId !== scope.projectId ||
      response.snapshot.metadata.scope.canvasId !== scope.canvasId ||
      response.scope.workspaceId !== scope.workspaceId ||
      response.scope.projectId !== scope.projectId ||
      response.scope.canvasId !== scope.canvasId
    ) {
      throw new CollaborationClientError({
        kind: "protocol",
        code: "canvas_replica_scope_mismatch",
        message: "canvas_replica_scope_mismatch"
      });
    }
    if (
      content.canonicalDigest !== response.snapshot.metadata.contentDigest ||
      content.canonicalDigest !== response.snapshot.content.canonicalDigest ||
      response.snapshot.content.versionId.length === 0
    ) {
      throw new CollaborationClientError({
        kind: "protocol",
        code: "canvas_replica_snapshot_content_mismatch",
        message: "canvas_replica_snapshot_content_mismatch",
        retryable: true
      });
    }

    this.store.installBaseline(scope, {
      content,
      revision: response.snapshot.metadata.revision,
      contentDigest: response.snapshot.metadata.contentDigest
    });
    this.store.setCanEdit(scope, canEdit);
  }

  /**
   * Synchronously enqueue optimistic pending + publish, then return a Promise for network outcome.
   * Must not await the network before the optimistic projection is published.
   */
  submit(scope: CanvasReplicaScope, intent: CanvasCommandIntent): Promise<CanvasCommandOutcome> {
    if (!this.store.has(scope) || !this.scopes.has(this.key(scope))) {
      return Promise.reject(
        new CollaborationClientError({
          kind: "aborted",
          code: "canvas_replica_scope_unbound",
          message: "canvas_replica_scope_unbound"
        })
      );
    }
    if (!this.store.canEdit(scope)) {
      return Promise.reject(forbiddenError());
    }
    const operationId = `op-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    this.store.enqueue(scope, { operationId, intent });
    return new Promise((resolve, reject) => {
      const scopeKey = this.key(scope);
      const queue = this.queues.get(scopeKey) ?? [];
      queue.push({ operationId, intent, resolve, reject, settled: false });
      this.queues.set(scopeKey, queue);
      void this.run(scope);
    });
  }

  async reconnect(
    scope: CanvasReplicaScope,
    input?: { afterRevision?: number; afterContentDigest?: string | null }
  ): Promise<CanvasReconnectResponse> {
    const scopeKey = this.key(scope);
    const generation = this.generations.get(scopeKey) ?? 0;
    const afterRevision = input?.afterRevision ?? this.store.revision(scope);
    const afterContentDigest =
      input?.afterContentDigest !== undefined
        ? input.afterContentDigest
        : this.store.digest(scope);
    const result = await this.transport.reconnect(scope, {
      afterRevision,
      afterContentDigest
    });
    if (!this.isCurrent(scopeKey, generation)) {
      throw disconnectedError();
    }
    this.applyReconnectResult(scope, result);
    return result.response;
  }

  clear(scope: CanvasReplicaScope): void {
    const scopeKey = this.key(scope);
    this.bumpGeneration(scopeKey);
    this.rejectQueue(scopeKey, disconnectedError());
    this.scopes.delete(scopeKey);
    this.store.clear(scope);
  }

  clearAll(): void {
    for (const scopeKey of [...this.scopes.keys()]) {
      this.bumpGeneration(scopeKey);
      this.rejectQueue(scopeKey, disconnectedError());
    }
    this.scopes.clear();
    this.store.clearAll();
  }

  private async run(scope: CanvasReplicaScope): Promise<void> {
    const scopeKey = this.key(scope);
    const generation = this.generations.get(scopeKey) ?? 0;
    const runningKey = `${scopeKey}:${generation}`;
    if (this.running.has(runningKey)) return;
    this.running.add(runningKey);
    try {
      while (true) {
        if (!this.isCurrent(scopeKey, generation)) return;
        const queue = this.queues.get(scopeKey);
        if (!queue?.length) return;
        const current = queue[0]!;
        try {
          if (!this.store.canEdit(scope)) {
            this.finishForbidden(scope, scopeKey);
            return;
          }
          const expectedRevision = this.store.revision(scope);
          const outcome = await this.transport.submit({
            scope,
            operationId: current.operationId,
            expectedRevision,
            intent: current.intent
          });
          if (!this.isCurrent(scopeKey, generation)) {
            settleReject(current, disconnectedError());
            return;
          }
          if (outcome.type === "canvas.command.accepted") {
            const { droppedPending } = this.store.accept(scope, outcome);
            this.rejectDropped(scopeKey, droppedPending);
            queue.shift();
            settleResolve(current, outcome);
            continue;
          }
          if (outcome.code === "stale_revision") {
            await this.recoverStaleRevision(scope, scopeKey, generation);
            if (!this.isCurrent(scopeKey, generation)) {
              settleReject(current, disconnectedError());
              return;
            }
            // Keep current at queue head and resubmit with the new committed revision.
            continue;
          }
          if (outcome.code === "forbidden") {
            this.store.reject(scope, current.operationId, outcome.code);
            queue.shift();
            settleResolve(current, outcome);
            this.finishForbidden(scope, scopeKey);
            return;
          }
          this.store.reject(scope, current.operationId, outcome.code);
          queue.shift();
          settleResolve(current, outcome);
        } catch (error) {
          if (!this.isCurrent(scopeKey, generation)) {
            settleReject(current, disconnectedError());
            return;
          }
          this.store.reject(scope, current.operationId, "transport_failed");
          queue.shift();
          settleReject(
            current,
            error instanceof Error
              ? error
              : new CollaborationClientError({
                  kind: "unknown",
                  code: "canvas_replica_transport_failed",
                  message: "canvas_replica_transport_failed",
                  retryable: true
                })
          );
        }
      }
    } finally {
      this.running.delete(runningKey);
      if (
        this.isCurrent(scopeKey, generation) &&
        (this.queues.get(scopeKey)?.length ?? 0) > 0
      ) {
        void this.run(scope);
      }
    }
  }

  private async recoverStaleRevision(
    scope: CanvasReplicaScope,
    scopeKey: string,
    generation: number
  ): Promise<void> {
    const result = await this.transport.reconnect(scope, {
      afterRevision: this.store.revision(scope),
      afterContentDigest: this.store.digest(scope)
    });
    if (!this.isCurrent(scopeKey, generation)) return;
    this.applyReconnectResult(scope, result);
  }

  private applyReconnectResult(
    scope: CanvasReplicaScope,
    result: {
      response: CanvasReconnectResponse;
      snapshotContent?: CompleteContentVersion;
    }
  ): void {
    const { droppedPending } = this.store.replaceFromReconnect({
      scope,
      response: result.response,
      snapshotContent: result.snapshotContent
    });
    this.rejectDropped(this.key(scope), droppedPending);
  }

  private finishForbidden(scope: CanvasReplicaScope, scopeKey: string): void {
    this.store.setCanEdit(scope, false);
    const removed = this.store.clearPending(scope, "canvas_replica_command_forbidden");
    this.rejectDropped(scopeKey, removed, forbiddenError());
    const queue = this.queues.get(scopeKey) ?? [];
    this.queues.set(scopeKey, []);
    for (const item of queue) {
      settleReject(item, forbiddenError());
    }
  }

  private rejectDropped(
    scopeKey: string,
    dropped: CanvasReplicaPendingOperation[],
    error: Error = new CollaborationClientError({
      kind: "protocol",
      code: "canvas_replica_pending_rebase_failed",
      message: "canvas_replica_pending_rebase_failed"
    })
  ): void {
    if (dropped.length === 0) return;
    const droppedIds = new Set(dropped.map((item) => item.operationId));
    const queue = this.queues.get(scopeKey) ?? [];
    const retained: Queued[] = [];
    for (const item of queue) {
      if (droppedIds.has(item.operationId)) {
        settleReject(item, error);
      } else {
        retained.push(item);
      }
    }
    this.queues.set(scopeKey, retained);
  }

  private rejectQueue(scopeKey: string, error: Error): void {
    const queue = this.queues.get(scopeKey) ?? [];
    this.queues.delete(scopeKey);
    for (const item of queue) settleReject(item, error);
  }

  private bumpGeneration(scopeKey: string): void {
    this.generations.set(scopeKey, (this.generations.get(scopeKey) ?? 0) + 1);
  }

  private isCurrent(scopeKey: string, generation: number): boolean {
    return (this.generations.get(scopeKey) ?? 0) === generation;
  }

  private key(scope: CanvasReplicaScope): string {
    return JSON.stringify([
      scope.authorityId,
      scope.workspaceId,
      scope.projectId,
      scope.canvasId
    ]);
  }
}
