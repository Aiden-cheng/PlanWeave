import {
  applyCanvasReplicaIntent,
  decodeCanvasReplicaDocument,
  encodeCanvasReplicaDocument,
  overlayCanvasReplicaRuntimeStatus,
  projectCanvasReplicaDocument,
  type CanvasReplicaDocument
} from "@planweave-ai/runtime";
import type {
  CanvasCommandIntent,
  CanvasCommandOutcome,
  CanvasJournalEntry,
  CanvasReconnectResponse,
  CanvasRuntimeStatusProjection,
  CompleteContentVersion
} from "@planweave-ai/collaboration-contracts";
import {
  collaborationCanvasReplicaProjectionSchema,
  type CollaborationCanvasReplicaProjection
} from "../../shared/canvasReplicaIpc.js";
import { CollaborationClientError } from "./collaborationErrors.js";

export type CanvasReplicaScope = {
  localProjectId: string;
  localCanvasId: string;
  projectId: string;
  canvasId: string;
  workspaceId: CanvasRuntimeStatusProjection["scope"]["workspaceId"];
};

type PendingOperation = { operationId: string; intent: CanvasCommandIntent };
type ReplicaState = {
  scope: CanvasReplicaScope;
  document: CanvasReplicaDocument | null;
  revision: number;
  contentDigest: string | null;
  pending: PendingOperation[];
  runtimeStatus: CanvasRuntimeStatusProjection | null;
  canEdit: boolean;
  rejections: Array<{ operationId: string; code: string }>;
};

function replicaError(code: string, retryable = false): CollaborationClientError {
  return new CollaborationClientError({ kind: "protocol", code, message: code, retryable });
}

function key(scope: Pick<CanvasReplicaScope, "workspaceId" | "projectId" | "canvasId">): string {
  return JSON.stringify([scope.workspaceId, scope.projectId, scope.canvasId]);
}

/**
 * Main-process authority cache for one remote Canvas. Disk materialization is intentionally
 * outside this store: only immutable content snapshots and ordered durable intents enter it.
 */
export class CanvasReplicaStore {
  private readonly replicas = new Map<string, ReplicaState>();

  constructor(private readonly onChange: (projection: CollaborationCanvasReplicaProjection) => void) {}

  bind(scope: CanvasReplicaScope): void {
    const current = this.replicas.get(key(scope));
    if (current) {
      current.scope = scope;
      return;
    }
    this.replicas.set(key(scope), {
      scope,
      document: null,
      revision: 0,
      contentDigest: null,
      pending: [],
      runtimeStatus: null,
      canEdit: false,
      rejections: []
    });
  }

  installBaseline(
    scope: CanvasReplicaScope,
    baseline: { content: CompleteContentVersion; revision: number; contentDigest: string }
  ): void {
    const replica = this.require(scope);
    const document = decodeCanvasReplicaDocument(baseline.content);
    this.assertDigest(document, baseline.contentDigest);
    replica.document = document;
    replica.revision = baseline.revision;
    replica.contentDigest = baseline.contentDigest;
    this.rebasePending(replica);
    this.publish(replica);
  }

  clear(scope: CanvasReplicaScope): void {
    this.replicas.delete(key(scope));
  }

  projection(scope: Pick<CanvasReplicaScope, "workspaceId" | "projectId" | "canvasId">): CollaborationCanvasReplicaProjection | null {
    const replica = this.replicas.get(key(scope));
    return replica?.document ? this.toProjection(replica) : null;
  }

  enqueue(scope: Pick<CanvasReplicaScope, "workspaceId" | "projectId" | "canvasId">, pending: PendingOperation): void {
    const replica = this.require(scope);
    if (!replica.canEdit) throw replicaError("canvas_replica_command_forbidden");
    if (replica.pending.some((item) => item.operationId === pending.operationId)) {
      throw replicaError("canvas_replica_operation_duplicate");
    }
    if (!replica.document || replica.contentDigest === null) {
      throw replicaError("canvas_replica_baseline_required", true);
    }
    replica.pending.push(pending);
    this.publish(replica);
  }

  reject(scope: Pick<CanvasReplicaScope, "workspaceId" | "projectId" | "canvasId">, operationId: string, code: string): void {
    const replica = this.require(scope);
    const before = replica.pending.length;
    replica.pending = replica.pending.filter((pending) => pending.operationId !== operationId);
    replica.rejections.push({ operationId, code });
    if (replica.pending.length === before) return;
    this.publish(replica);
  }

  /** Apply a live or HTTP journal entry strictly at the next revision. */
  applyEntry(entry: CanvasJournalEntry): void {
    const replica = this.require(entry.scope);
    if (!replica.document || replica.contentDigest === null) {
      throw replicaError("canvas_replica_baseline_required", true);
    }
    if (entry.revision === replica.revision && entry.contentDigest === replica.contentDigest) {
      if (replica.pending.some((pending) => pending.operationId === entry.operationId)) {
        throw replicaError("canvas_replica_duplicate_pending_acceptance");
      }
      return;
    }
    if (entry.previousRevision !== replica.revision || entry.revision !== replica.revision + 1) {
      throw replicaError("canvas_replica_revision_gap", true);
    }
    const next = applyCanvasReplicaIntent(replica.document, entry.intent);
    this.assertDigest(next, entry.contentDigest);
    replica.document = next;
    replica.revision = entry.revision;
    replica.contentDigest = entry.contentDigest;
    replica.pending = replica.pending.filter((pending) => pending.operationId !== entry.operationId);
    this.rebasePending(replica);
    this.publish(replica);
  }

  /** Own HTTP acceptance carries no entry, so it is folded with its exact queued intent. */
  accept(
    scope: Pick<CanvasReplicaScope, "workspaceId" | "projectId" | "canvasId">,
    outcome: Extract<CanvasCommandOutcome, { type: "canvas.command.accepted" }>
  ): void {
    const replica = this.require(scope);
    const pending = replica.pending[0];
    if (!pending || pending.operationId !== outcome.operationId) {
      if (outcome.revision === replica.revision && outcome.contentDigest === replica.contentDigest) return;
      throw replicaError("canvas_replica_acceptance_without_pending", true);
    }
    if (!replica.document || replica.contentDigest === null || outcome.revision !== replica.revision + 1) {
      throw replicaError("canvas_replica_acceptance_revision_mismatch", true);
    }
    const next = applyCanvasReplicaIntent(replica.document, pending.intent);
    this.assertDigest(next, outcome.contentDigest);
    replica.document = next;
    replica.revision = outcome.revision;
    replica.contentDigest = outcome.contentDigest;
    replica.pending.shift();
    this.rebasePending(replica);
    this.publish(replica);
  }

  /** Replace the immutable baseline then replay its validated ordered delta. */
  replaceFromReconnect(input: {
    scope: Pick<CanvasReplicaScope, "workspaceId" | "projectId" | "canvasId">;
    response: CanvasReconnectResponse;
    snapshotContent?: CompleteContentVersion;
  }): void {
    const replica = this.require(input.scope);
    const { response } = input;
    if (response.type === "canvas.reconnect.error") {
      throw replicaError(`canvas_replica_reconnect_${response.code}`);
    }
    if (response.type === "canvas.reconnect.snapshot") {
      if (!input.snapshotContent) throw replicaError("canvas_replica_snapshot_content_required", true);
      if (
        response.snapshot.metadata.scope.workspaceId !== replica.scope.workspaceId ||
        response.snapshot.metadata.scope.projectId !== replica.scope.projectId ||
        response.snapshot.metadata.scope.canvasId !== replica.scope.canvasId
      ) {
        throw replicaError("canvas_replica_scope_mismatch");
      }
      const document = decodeCanvasReplicaDocument(input.snapshotContent);
      this.assertDigest(document, response.snapshot.metadata.contentDigest);
      replica.document = document;
      replica.revision = response.snapshot.metadata.revision;
      replica.contentDigest = response.snapshot.metadata.contentDigest;
      this.rebasePending(replica);
      this.publish(replica);
      return;
    }
    if (!replica.document) throw replicaError("canvas_replica_baseline_required", true);
    let document = replica.document;
    let revision = replica.revision;
    let digest = replica.contentDigest;
    for (const entry of response.entries) {
      if (
        entry.scope.workspaceId !== replica.scope.workspaceId ||
        entry.scope.projectId !== replica.scope.projectId ||
        entry.scope.canvasId !== replica.scope.canvasId ||
        entry.previousRevision !== revision ||
        entry.revision !== revision + 1
      ) {
        throw replicaError("canvas_replica_reconnect_delta_invalid", true);
      }
      document = applyCanvasReplicaIntent(document, entry.intent);
      this.assertDigest(document, entry.contentDigest);
      revision = entry.revision;
      digest = entry.contentDigest;
    }
    if (revision !== response.headRevision || digest !== response.headContentDigest) {
      throw replicaError("canvas_replica_reconnect_head_mismatch", true);
    }
    replica.document = document;
    replica.revision = revision;
    replica.contentDigest = digest;
    this.rebasePending(replica);
    this.publish(replica);
  }

  setRuntimeStatus(
    scope: Pick<CanvasReplicaScope, "workspaceId" | "projectId" | "canvasId">,
    status: CanvasRuntimeStatusProjection | null
  ): void {
    const replica = this.require(scope);
    replica.runtimeStatus = status;
    if (replica.document) this.publish(replica);
  }

  setCanEdit(
    scope: Pick<CanvasReplicaScope, "workspaceId" | "projectId" | "canvasId">,
    canEdit: boolean
  ): void {
    const replica = this.require(scope);
    replica.canEdit = canEdit;
    if (replica.document) this.publish(replica);
  }

  revision(scope: Pick<CanvasReplicaScope, "workspaceId" | "projectId" | "canvasId">): number {
    return this.require(scope).revision;
  }

  digest(scope: Pick<CanvasReplicaScope, "workspaceId" | "projectId" | "canvasId">): string | null {
    return this.require(scope).contentDigest;
  }

  canEdit(scope: Pick<CanvasReplicaScope, "workspaceId" | "projectId" | "canvasId">): boolean {
    return this.require(scope).canEdit;
  }

  private require(scope: Pick<CanvasReplicaScope, "workspaceId" | "projectId" | "canvasId">): ReplicaState {
    const replica = this.replicas.get(key(scope));
    if (!replica) throw replicaError("canvas_replica_scope_unbound");
    return replica;
  }

  private assertDigest(document: CanvasReplicaDocument, expected: string): void {
    if (encodeCanvasReplicaDocument(document).canonicalDigest !== expected) {
      throw replicaError("canvas_replica_canonical_digest_mismatch", true);
    }
  }

  private publish(replica: ReplicaState): void {
    if (!replica.document) return;
    this.onChange(this.toProjection(replica));
  }

  private toProjection(replica: ReplicaState): CollaborationCanvasReplicaProjection {
    if (!replica.document || !replica.contentDigest) throw replicaError("canvas_replica_baseline_required");
    const visibleDocument = this.visibleDocument(replica);
    const content = overlayCanvasReplicaRuntimeStatus({
      content: projectCanvasReplicaDocument(visibleDocument),
      status: replica.runtimeStatus,
      scope: {
        workspaceId: replica.scope.workspaceId,
        projectId: replica.scope.projectId,
        canvasId: replica.scope.canvasId
      }
    });
    return collaborationCanvasReplicaProjectionSchema.parse({
      localProjectId: replica.scope.localProjectId,
      localCanvasId: replica.scope.localCanvasId,
      projectId: replica.scope.projectId,
      canvasId: replica.scope.canvasId,
      revision: replica.revision,
      contentDigest: replica.contentDigest,
      canEdit: replica.canEdit,
      optimisticOperationIds: replica.pending.map((pending) => pending.operationId),
      rejections: replica.rejections,
      content: {
        projectTitle: content.projectTitle,
        graphVersion: content.graphVersion,
        packageFingerprint: content.packageFingerprint,
        tasks: content.tasks,
        edges: content.edges,
        sharedResourceGroups: content.sharedResourceGroups,
        diagnostics: content.diagnostics
      }
    });
  }

  private visibleDocument(replica: ReplicaState): CanvasReplicaDocument {
    if (!replica.document) throw replicaError("canvas_replica_baseline_required");
    let visible = replica.document;
    for (const pending of replica.pending) {
      visible = applyCanvasReplicaIntent(visible, pending.intent);
    }
    return visible;
  }

  private rebasePending(replica: ReplicaState): void {
    if (!replica.document) return;
    let visible = replica.document;
    const retained: PendingOperation[] = [];
    for (const pending of replica.pending) {
      try {
        visible = applyCanvasReplicaIntent(visible, pending.intent);
        retained.push(pending);
      } catch {
        replica.rejections.push({ operationId: pending.operationId, code: "canvas_replica_pending_rebase_failed" });
      }
    }
    replica.pending = retained;
    replica.rejections = replica.rejections.slice(-100);
  }
}
