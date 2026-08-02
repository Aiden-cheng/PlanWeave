import { randomUUID } from "node:crypto";
import type {
  CanvasCommandIntent,
  CanvasCommandOutcome,
  CompleteContentVersion
} from "@planweave-ai/collaboration-contracts";
import type { CanvasReplicaScope } from "./CanvasReplicaStore.js";
import { CanvasReplicaStore } from "./CanvasReplicaStore.js";
import { CollaborationClientError } from "./collaborationErrors.js";

export type CanvasReplicaCommandTransport = {
  fetchBaseline(scope: CanvasReplicaScope): Promise<{
    content: CompleteContentVersion;
    revision: number;
    contentDigest: string;
  }>;
  canPersistCanvasCommand(scope: CanvasReplicaScope): Promise<boolean>;
  submit(input: {
    scope: CanvasReplicaScope;
    operationId: string;
    expectedRevision: number;
    intent: CanvasCommandIntent;
  }): Promise<CanvasCommandOutcome>;
};

type Queued = { operationId: string; intent: CanvasCommandIntent; resolve: (outcome: CanvasCommandOutcome) => void; reject: (error: Error) => void };

/** Per-remote-scope serialized command authority. Renderer cannot supply CAS or operation IDs. */
export class CanvasReplicaCommandWorker {
  private readonly queues = new Map<string, Queued[]>();
  private readonly running = new Set<string>();
  private readonly generations = new Map<string, number>();

  constructor(private readonly store: CanvasReplicaStore, private readonly transport: CanvasReplicaCommandTransport) {}

  async bind(scope: CanvasReplicaScope): Promise<void> {
    this.store.bind(scope);
    const [baseline, canEdit] = await Promise.all([
      this.transport.fetchBaseline(scope),
      this.transport.canPersistCanvasCommand(scope)
    ]);
    this.store.installBaseline(scope, baseline);
    this.store.setCanEdit(scope, canEdit);
  }

  submit(scope: CanvasReplicaScope, intent: CanvasCommandIntent): Promise<CanvasCommandOutcome> {
    if (!this.store.canEdit(scope)) {
      return Promise.reject(new CollaborationClientError({ kind: "forbidden", code: "canvas_replica_command_forbidden", message: "canvas_replica_command_forbidden" }));
    }
    const operationId = `op-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    this.store.enqueue(scope, { operationId, intent });
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(this.key(scope)) ?? [];
      queue.push({ operationId, intent, resolve, reject });
      this.queues.set(this.key(scope), queue);
      void this.run(scope);
    });
  }

  clear(scope: CanvasReplicaScope): void {
    const key = this.key(scope);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    const queue = this.queues.get(key) ?? [];
    this.queues.delete(key);
    for (const item of queue) item.reject(new Error("canvas_replica_session_disconnected"));
    this.store.clear(scope);
  }

  private async run(scope: CanvasReplicaScope): Promise<void> {
    const key = this.key(scope);
    const generation = this.generations.get(key) ?? 0;
    const runningKey = `${key}:${generation}`;
    if (this.running.has(runningKey)) return;
    this.running.add(runningKey);
    try {
      const queue = this.queues.get(key);
      while (queue?.length) {
        const current = queue[0]!;
        try {
          const outcome = await this.transport.submit({ scope, operationId: current.operationId, expectedRevision: this.store.revision(scope), intent: current.intent });
          if (generation !== (this.generations.get(key) ?? 0)) {
            current.reject(new Error("canvas_replica_session_disconnected"));
            return;
          }
          if (outcome.type === "canvas.command.accepted") this.store.accept(scope, outcome);
          else this.store.reject(scope, current.operationId, outcome.code);
          queue.shift();
          current.resolve(outcome);
        } catch (error) {
          if (generation !== (this.generations.get(key) ?? 0)) {
            current.reject(new Error("canvas_replica_session_disconnected"));
            return;
          }
          this.store.reject(scope, current.operationId, "transport_failed");
          queue.shift();
          current.reject(error instanceof Error ? error : new Error("canvas_replica_transport_failed"));
        }
      }
    } finally {
      this.running.delete(runningKey);
      if ((this.queues.get(key)?.length ?? 0) > 0) void this.run(scope);
    }
  }

  private key(scope: CanvasReplicaScope): string {
    return JSON.stringify([scope.workspaceId, scope.projectId, scope.canvasId]);
  }
}
