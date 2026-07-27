import {
  CANVAS_COMMAND_MAX_JOURNAL_DELTA_ENTRIES,
  CANVAS_COMMAND_PROTOCOL_VERSION,
  canvasCommandAcceptedSchema,
  canvasCommandSubmitSchema,
  canvasReconnectDeltaSchema,
  canvasReconnectErrorSchema,
  canvasReconnectRequestSchema,
  canvasReconnectSnapshotSchema,
  type ActorRef,
  type CanvasCommandAccepted,
  type CanvasCommandOutcome,
  type CanvasCommandSubmit,
  type CanvasReconnectRequest,
  type CanvasReconnectResponse
} from "@planweave-ai/collaboration-contracts";
import type { HumanAuthContext } from "../identity/schemas.js";
import type { ProjectAccessRepository } from "../projectAccessRepository.js";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { authorizeCanvasRead, authorizeCanvasWrite } from "./policy.js";
import {
  CanvasCommandRepository,
  digestCanvasIntent,
  rejectedOutcome,
  type CanvasScopeKey
} from "./repository.js";
import type { CanvasRuntimeMutationPort } from "./runtimePort.js";

export type CanvasCommandServiceOptions = {
  repository: CanvasCommandRepository;
  access: ProjectAccessRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
  runtime: CanvasRuntimeMutationPort;
  clock?: () => Date;
  /**
   * Optional presence hub probe — only used in negative tests to prove presence is never
   * a durable mutation source. Production composition leaves this undefined.
   */
  presenceHeadProbe?: (scope: { projectId: string; canvasId: string }) => number | undefined;
};

function actorFrom(context: HumanAuthContext): ActorRef {
  return {
    kind: "human",
    id: context.humanPrincipalId,
    displayName: context.displayName
  };
}

function scopeKey(scope: {
  workspaceId: string;
  projectId: string;
  canvasId: string;
}): CanvasScopeKey {
  return {
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    canvasId: scope.canvasId
  };
}

/**
 * Server-authoritative Canvas command service: ACL, CAS, serialization, idempotency,
 * journal/snapshot persistence, and reconnect. Presence is never consulted for mutations.
 */
export class CanvasCommandService {
  private readonly clock: () => Date;
  /** Per-canvas in-process serializer (complements SQLite IMMEDIATE transactions). */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly options: CanvasCommandServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  private chainKey(scope: CanvasScopeKey): string {
    return `${scope.workspaceId}\0${scope.projectId}\0${scope.canvasId}`;
  }

  private async serialize<T>(scope: CanvasScopeKey, action: () => Promise<T>): Promise<T> {
    const key = this.chainKey(scope);
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => gate);
    this.chains.set(key, next);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.chains.get(key) === next) this.chains.delete(key);
    }
  }

  async submit(
    actor: HumanAuthContext,
    rawSubmit: unknown
  ): Promise<CanvasCommandOutcome> {
    const parsed = canvasCommandSubmitSchema.safeParse(rawSubmit);
    if (!parsed.success) {
      const projectId =
        typeof (rawSubmit as { projectId?: unknown })?.projectId === "string"
          ? String((rawSubmit as { projectId: string }).projectId)
          : actor.projectId;
      const canvasId =
        typeof (rawSubmit as { canvasId?: unknown })?.canvasId === "string"
          ? String((rawSubmit as { canvasId: string }).canvasId)
          : "unknown";
      const operationId =
        typeof (rawSubmit as { operationId?: unknown })?.operationId === "string"
          ? String((rawSubmit as { operationId: string }).operationId)
          : "invalid-operation";
      return rejectedOutcome({
        projectId,
        canvasId,
        operationId,
        code: "invalid_command",
        detail: "submit_schema_invalid"
      });
    }
    const submit = parsed.data;
    // Presence must never gate durable mutations.
    void this.options.presenceHeadProbe?.({
      projectId: submit.projectId,
      canvasId: submit.canvasId
    });

    const auth = authorizeCanvasWrite({
      actor,
      projectId: submit.projectId,
      canvasId: submit.canvasId,
      access: this.options.access,
      workspaceIdentity: this.options.workspaceIdentity
    });
    if (!auth.ok) {
      return rejectedOutcome({
        projectId: submit.projectId,
        canvasId: submit.canvasId,
        operationId: submit.operationId,
        code: auth.code,
        detail: auth.code === "forbidden" ? "canvas_write_denied" : undefined
      });
    }

    const scope = scopeKey(auth.scope);
    return this.serialize(scope, () => this.submitAuthorized(actor, submit, auth));
  }

  private async submitAuthorized(
    actor: HumanAuthContext,
    submit: CanvasCommandSubmit,
    auth: Extract<ReturnType<typeof authorizeCanvasWrite>, { ok: true }>
  ): Promise<CanvasCommandOutcome> {
    const scope = scopeKey(auth.scope);
    const intentDigest = digestCanvasIntent(submit.intent);
    const existing = this.options.repository.getOperation(scope, submit.operationId);
    if (existing) {
      if (existing.intentDigest !== intentDigest) {
        return rejectedOutcome({
          projectId: submit.projectId,
          canvasId: submit.canvasId,
          operationId: submit.operationId,
          code: "operation_conflict",
          detail: "operation_id_intent_mismatch"
        });
      }
      if (existing.outcome.type === "canvas.command.accepted") {
        return canvasCommandAcceptedSchema.parse({
          ...existing.outcome,
          idempotentReplay: true
        });
      }
      return existing.outcome;
    }

    // Re-check ACL inside the serializer (covers revocation races).
    const reauth = authorizeCanvasWrite({
      actor,
      projectId: submit.projectId,
      canvasId: submit.canvasId,
      access: this.options.access,
      workspaceIdentity: this.options.workspaceIdentity
    });
    if (!reauth.ok) {
      return rejectedOutcome({
        projectId: submit.projectId,
        canvasId: submit.canvasId,
        operationId: submit.operationId,
        code: reauth.code,
        detail: reauth.code === "forbidden" ? "canvas_write_denied" : undefined
      });
    }

    const head = this.options.repository.head(scope);
    if (submit.expectedRevision !== head.revision) {
      return rejectedOutcome({
        projectId: submit.projectId,
        canvasId: submit.canvasId,
        operationId: submit.operationId,
        code: "stale_revision",
        conflict: {
          expectedRevision: submit.expectedRevision,
          authoritativeRevision: head.revision,
          authoritativeContentDigest: head.contentDigest
        }
      });
    }

    const actorRef = actorFrom(actor);
    this.options.repository.reservePending({
      scope,
      operationId: submit.operationId,
      expectedRevision: submit.expectedRevision,
      intent: submit.intent,
      intentDigest,
      actor: actorRef
    });

    let applied;
    try {
      applied = await this.options.runtime.apply({
        // Server-resolved project root + ACL-bound packageDir; Runtime parses package only.
        projectRoot: reauth.projectRoot,
        canvasId: submit.canvasId,
        expectedPackageDir: reauth.packageDir,
        intent: submit.intent
      });
    } catch (error) {
      this.options.repository.markPendingNeedsRecovery(scope, submit.operationId);
      return rejectedOutcome({
        projectId: submit.projectId,
        canvasId: submit.canvasId,
        operationId: submit.operationId,
        code: "server_error",
        detail: error instanceof Error ? error.message.slice(0, 200) : "runtime_apply_failed"
      });
    }

    if (!applied.ok) {
      this.options.repository.clearPending(scope, submit.operationId);
      const code =
        applied.code === "invalid_command"
          ? "invalid_command"
          : applied.code === "package_mismatch"
            ? "unknown_canvas"
            : "server_error";
      const rejected = rejectedOutcome({
        projectId: submit.projectId,
        canvasId: submit.canvasId,
        operationId: submit.operationId,
        code,
        detail: applied.detail.slice(0, 200)
      });
      if (code === "invalid_command") {
        this.options.repository.storeRejected({
          scope,
          operationId: submit.operationId,
          intent: submit.intent,
          intentDigest,
          rejected
        });
      }
      return rejected;
    }

    // CAS re-check immediately before durable commit (concurrent writers).
    const headAfter = this.options.repository.head(scope);
    if (headAfter.revision !== submit.expectedRevision) {
      this.options.repository.markPendingNeedsRecovery(scope, submit.operationId);
      return rejectedOutcome({
        projectId: submit.projectId,
        canvasId: submit.canvasId,
        operationId: submit.operationId,
        code: "stale_revision",
        conflict: {
          expectedRevision: submit.expectedRevision,
          authoritativeRevision: headAfter.revision,
          authoritativeContentDigest: headAfter.contentDigest
        }
      });
    }

    try {
      return this.options.repository.commitAccepted({
        scope,
        operationId: submit.operationId,
        intent: submit.intent,
        intentDigest,
        actor: actorRef,
        previousRevision: submit.expectedRevision,
        revision: submit.expectedRevision + 1,
        contentDigest: applied.contentDigest,
        digestManifest: applied.digestManifest,
        sizeBytes: applied.sizeBytes
      });
    } catch (error) {
      this.options.repository.markPendingNeedsRecovery(scope, submit.operationId);
      return rejectedOutcome({
        projectId: submit.projectId,
        canvasId: submit.canvasId,
        operationId: submit.operationId,
        code: "journal_unavailable",
        detail: error instanceof Error ? error.message.slice(0, 200) : "journal_commit_failed"
      });
    }
  }

  async reconnect(
    actor: HumanAuthContext,
    rawRequest: unknown
  ): Promise<CanvasReconnectResponse> {
    const parsed = canvasReconnectRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      const projectId =
        typeof (rawRequest as { projectId?: unknown })?.projectId === "string"
          ? String((rawRequest as { projectId: string }).projectId)
          : actor.projectId;
      const canvasId =
        typeof (rawRequest as { canvasId?: unknown })?.canvasId === "string"
          ? String((rawRequest as { canvasId: string }).canvasId)
          : "unknown";
      return canvasReconnectErrorSchema.parse({
        type: "canvas.reconnect.error",
        protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
        schemaVersion: "canvas-command/v1",
        projectId,
        canvasId,
        code: "invalid_request",
        detail: "reconnect_schema_invalid"
      });
    }
    const request = parsed.data;
    const auth = authorizeCanvasRead({
      actor,
      projectId: request.projectId,
      canvasId: request.canvasId,
      access: this.options.access,
      workspaceIdentity: this.options.workspaceIdentity
    });
    if (!auth.ok) {
      return canvasReconnectErrorSchema.parse({
        type: "canvas.reconnect.error",
        protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
        schemaVersion: "canvas-command/v1",
        projectId: request.projectId,
        canvasId: request.canvasId,
        code: auth.code
      });
    }
    const scope = scopeKey(auth.scope);
    return this.serialize(scope, () => this.reconnectAuthorized(request, scope, auth));
  }

  private async reconnectAuthorized(
    request: CanvasReconnectRequest,
    scope: CanvasScopeKey,
    auth: Extract<ReturnType<typeof authorizeCanvasRead>, { ok: true }>
  ): Promise<CanvasReconnectResponse> {
    const authorizedScope = {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      canvasId: scope.canvasId
    };
    let head = this.options.repository.head(scope);
    if (head.revision === 0 && head.contentDigest === "0".repeat(64)) {
      const digest = await this.options.runtime.readDigest({
        projectRoot: auth.projectRoot,
        canvasId: request.canvasId,
        expectedPackageDir: auth.packageDir
      });
      if (digest.ok) {
        head = this.options.repository.ensureInitialHead(scope, digest.contentDigest);
      }
    }

    if (request.afterRevision > head.revision) {
      const snapshot = this.options.repository.getSnapshot(scope);
      if (!snapshot || !this.verifySnapshot(snapshot.metadata.contentDigest, snapshot)) {
        return canvasReconnectErrorSchema.parse({
          type: "canvas.reconnect.error",
          protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
          schemaVersion: "canvas-command/v1",
          projectId: request.projectId,
          canvasId: request.canvasId,
          code: "snapshot_malformed",
          detail: "revision_ahead_without_verified_snapshot"
        });
      }
      return canvasReconnectSnapshotSchema.parse({
        type: "canvas.reconnect.snapshot",
        protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
        schemaVersion: "canvas-command/v1",
        scope: authorizedScope,
        reason: "revision_ahead",
        afterRevision: request.afterRevision,
        snapshot
      });
    }

    if (request.afterContentDigest !== undefined && request.afterRevision > 0) {
      const entry = this.options.repository.journalEntryAt(scope, request.afterRevision);
      const digestAt =
        entry?.contentDigest ??
        (request.afterRevision === head.revision ? head.contentDigest : undefined);
      if (digestAt !== undefined && digestAt !== request.afterContentDigest) {
        const snapshot = this.verifiedSnapshotOrError(scope, request, "digest_mismatch");
        return snapshot;
      }
    }

    const oldest = this.options.repository.oldestRetainedRevision(scope);
    if (request.afterRevision === 0 && head.revision === 0) {
      const snapshot = this.options.repository.getSnapshot(scope, 0);
      if (snapshot && this.verifySnapshot(snapshot.metadata.contentDigest, snapshot)) {
        return canvasReconnectSnapshotSchema.parse({
          type: "canvas.reconnect.snapshot",
          protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
          schemaVersion: "canvas-command/v1",
          scope: authorizedScope,
          reason: "fresh_session",
          afterRevision: 0,
          snapshot
        });
      }
      return canvasReconnectDeltaSchema.parse({
        type: "canvas.reconnect.delta",
        protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
        schemaVersion: "canvas-command/v1",
        scope: authorizedScope,
        afterRevision: 0,
        headRevision: 0,
        headContentDigest: head.contentDigest,
        entries: []
      });
    }

    if (request.afterRevision > 0 && oldest > 0 && request.afterRevision < oldest - 0) {
      // If the next entry is not contiguous from afterRevision, journal was truncated.
      const entriesProbe = this.options.repository.listJournalAfter(scope, request.afterRevision);
      if (
        entriesProbe.length === 0
          ? request.afterRevision !== head.revision
          : entriesProbe[0]!.previousRevision !== request.afterRevision
      ) {
        return this.verifiedSnapshotOrError(scope, request, "truncated_journal");
      }
    }

    if (oldest > 0 && request.afterRevision < oldest - 1) {
      // Retention dropped history before the client's cursor.
      const first = this.options.repository.listJournalAfter(scope, oldest - 1)[0];
      if (!first || first.previousRevision > request.afterRevision) {
        return this.verifiedSnapshotOrError(scope, request, "retention_gap");
      }
    }

    const entries = this.options.repository.listJournalAfter(scope, request.afterRevision);
    if (entries.length > CANVAS_COMMAND_MAX_JOURNAL_DELTA_ENTRIES) {
      return this.verifiedSnapshotOrError(scope, request, "truncated_journal");
    }
    if (entries.length === 0) {
      if (request.afterRevision !== head.revision) {
        return this.verifiedSnapshotOrError(scope, request, "retention_gap");
      }
      return canvasReconnectDeltaSchema.parse({
        type: "canvas.reconnect.delta",
        protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
        schemaVersion: "canvas-command/v1",
        scope: authorizedScope,
        afterRevision: request.afterRevision,
        headRevision: head.revision,
        headContentDigest: head.contentDigest,
        entries: []
      });
    }
    if (entries[0]!.previousRevision !== request.afterRevision) {
      return this.verifiedSnapshotOrError(scope, request, "truncated_journal");
    }

    return canvasReconnectDeltaSchema.parse({
      type: "canvas.reconnect.delta",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      scope: authorizedScope,
      afterRevision: request.afterRevision,
      headRevision: head.revision,
      headContentDigest: head.contentDigest,
      entries
    });
  }

  private verifiedSnapshotOrError(
    scope: CanvasScopeKey,
    request: CanvasReconnectRequest,
    reason: "retention_gap" | "digest_mismatch" | "truncated_journal" | "fresh_session"
  ): CanvasReconnectResponse {
    const snapshot = this.options.repository.getSnapshot(scope);
    if (!snapshot || !this.verifySnapshot(snapshot.metadata.contentDigest, snapshot)) {
      return canvasReconnectErrorSchema.parse({
        type: "canvas.reconnect.error",
        protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
        schemaVersion: "canvas-command/v1",
        projectId: request.projectId,
        canvasId: request.canvasId,
        code: "snapshot_malformed",
        detail: reason
      });
    }
    return canvasReconnectSnapshotSchema.parse({
      type: "canvas.reconnect.snapshot",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      scope: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        canvasId: scope.canvasId
      },
      reason,
      afterRevision: request.afterRevision,
      snapshot
    });
  }

  private verifySnapshot(
    expectedDigest: string,
    snapshot: { metadata: { contentDigest: string }; encoding: string }
  ): boolean {
    if (snapshot.metadata.contentDigest !== expectedDigest) return false;
    if (!/^[a-f0-9]{64}$/.test(snapshot.metadata.contentDigest)) return false;
    return true;
  }

  /**
   * Crash-safe recovery after apply/commit interruption.
   * Package FS is source of truth for content digest; journal is authoritative for revision.
   * When package digest advanced past journal head (apply succeeded, commit failed), advance
   * the journal with a recovery commit so clients do not double-apply on retry.
   * When package still matches head, drop pending so the client can retry safely.
   */
  async recoverInterrupted(): Promise<{ cleared: number; recovered: number }> {
    const pending = this.options.repository.listNeedsRecovery();
    let cleared = 0;
    let recovered = 0;
    for (const item of pending) {
      const op = this.options.repository.getOperation(item.scope, item.operationId);
      if (op) {
        this.options.repository.clearPending(item.scope, item.operationId);
        cleared += 1;
        continue;
      }

      const head = this.options.repository.head(item.scope);
      let packageDigest: string | null = null;
      try {
        const location = this.options.access.registry.resolveCanvasPath({
          workspaceId: item.scope.workspaceId,
          projectId: item.scope.projectId,
          canvasId: item.scope.canvasId
        });
        const digest = await this.options.runtime.readDigest({
          projectRoot: location.projectRoot,
          canvasId: item.scope.canvasId,
          expectedPackageDir: location.packageDir
        });
        if (digest.ok) {
          packageDigest = digest.contentDigest;
        }
      } catch {
        packageDigest = null;
      }

      if (
        packageDigest !== null &&
        packageDigest !== head.contentDigest &&
        head.revision === item.expectedRevision
      ) {
        // Apply mutated package; journal never committed — align revision to package.
        this.options.repository.commitAccepted({
          scope: item.scope,
          operationId: item.operationId,
          intent: item.intent,
          intentDigest: item.intentDigest,
          actor: item.actor,
          previousRevision: head.revision,
          revision: head.revision + 1,
          contentDigest: packageDigest
        });
        recovered += 1;
        cleared += 1;
        continue;
      }

      // Apply did not change package (or location unavailable) — drop pending for safe retry.
      this.options.repository.clearPending(item.scope, item.operationId);
      cleared += 1;
    }
    return { cleared, recovered };
  }

  /** Test/diagnostic head read; not a presence cursor. */
  head(scope: CanvasScopeKey) {
    return this.options.repository.head(scope);
  }
}

export type { CanvasCommandAccepted };
