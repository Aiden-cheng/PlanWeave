import { createHash, randomUUID } from "node:crypto";
import {
  CANVAS_COMMAND_PROTOCOL_VERSION,
  canvasCommandAcceptedSchema,
  canvasCommandOutcomeSchema,
  canvasCommandRejectedSchema,
  canvasJournalEntrySchema,
  canvasSnapshotContentSchema,
  canvasSnapshotMetadataSchema,
  type ActorRef,
  type CanvasCommandAccepted,
  type CanvasCommandIntent,
  type CanvasCommandOutcome,
  type CanvasCommandRejected,
  type CanvasJournalEntry,
  type CanvasSnapshotContent,
  type CanvasSnapshotMetadata,
  type PackageSnapshotDigestManifest
} from "@planweave-ai/collaboration-contracts";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import {
  CANVAS_COMMAND_JOURNAL_RETAINED_DEFAULT,
  CANVAS_COMMAND_SNAPSHOT_RETAINED_DEFAULT
} from "./limits.js";

export type CanvasScopeKey = {
  workspaceId: string;
  projectId: string;
  canvasId: string;
};

export type CanvasHead = {
  revision: number;
  contentDigest: string;
  updatedAt: string;
};

export type CanvasOperationRecord = {
  operationId: string;
  intentDigest: string;
  intent: CanvasCommandIntent;
  outcome: CanvasCommandOutcome;
  accepted: boolean;
  revision: number | null;
  journalEntryId: string | null;
  createdAt: string;
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

export function digestCanvasIntent(intent: CanvasCommandIntent): string {
  return createHash("sha256").update(stableStringify(intent)).digest("hex");
}

const EMPTY_DIGEST = "0".repeat(64);

export type CanvasCommandRepositoryOptions = {
  clock?: () => Date;
  maxJournalEntries?: number;
  maxSnapshots?: number;
};

export class CanvasCommandRepository {
  private readonly clock: () => Date;
  private readonly maxJournalEntries: number;
  private readonly maxSnapshots: number;

  constructor(
    private readonly database: SqliteDatabase,
    options: CanvasCommandRepositoryOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.maxJournalEntries = options.maxJournalEntries ?? CANVAS_COMMAND_JOURNAL_RETAINED_DEFAULT;
    this.maxSnapshots = options.maxSnapshots ?? CANVAS_COMMAND_SNAPSHOT_RETAINED_DEFAULT;
    if (!Number.isSafeInteger(this.maxJournalEntries) || this.maxJournalEntries < 1) {
      throw new Error("canvas_journal_retention_invalid");
    }
    if (!Number.isSafeInteger(this.maxSnapshots) || this.maxSnapshots < 1) {
      throw new Error("canvas_snapshot_retention_invalid");
    }
  }

  head(scope: CanvasScopeKey): CanvasHead {
    const row = this.database
      .prepare(
        `SELECT revision,content_digest,updated_at FROM canvas_command_heads
         WHERE workspace_id=? AND project_id=? AND canvas_id=?`
      )
      .get(scope.workspaceId, scope.projectId, scope.canvasId) as
      | { revision: number; content_digest: string; updated_at: string }
      | undefined;
    if (!row) {
      return { revision: 0, contentDigest: EMPTY_DIGEST, updatedAt: this.clock().toISOString() };
    }
    return {
      revision: Number(row.revision),
      contentDigest: String(row.content_digest),
      updatedAt: String(row.updated_at)
    };
  }

  getOperation(scope: CanvasScopeKey, operationId: string): CanvasOperationRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT operation_id,intent_digest,intent_json,outcome_json,accepted,revision,journal_entry_id,created_at
         FROM canvas_command_operations
         WHERE workspace_id=? AND project_id=? AND canvas_id=? AND operation_id=?`
      )
      .get(scope.workspaceId, scope.projectId, scope.canvasId, operationId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return {
      operationId: String(row.operation_id),
      intentDigest: String(row.intent_digest),
      intent: JSON.parse(String(row.intent_json)) as CanvasCommandIntent,
      outcome: canvasCommandOutcomeSchema.parse(JSON.parse(String(row.outcome_json))),
      accepted: Number(row.accepted) === 1,
      revision: row.revision === null || row.revision === undefined ? null : Number(row.revision),
      journalEntryId:
        row.journal_entry_id === null || row.journal_entry_id === undefined
          ? null
          : String(row.journal_entry_id),
      createdAt: String(row.created_at)
    };
  }

  listJournalAfter(scope: CanvasScopeKey, afterRevision: number): CanvasJournalEntry[] {
    const rows = this.database
      .prepare(
        `SELECT entry_json FROM canvas_command_journal
         WHERE workspace_id=? AND project_id=? AND canvas_id=? AND revision>?
         ORDER BY revision ASC`
      )
      .all(scope.workspaceId, scope.projectId, scope.canvasId, afterRevision) as Array<{
      entry_json: string;
    }>;
    return rows.map((row) => canvasJournalEntrySchema.parse(JSON.parse(row.entry_json)));
  }

  oldestRetainedRevision(scope: CanvasScopeKey): number {
    const row = this.database
      .prepare(
        `SELECT MIN(revision) AS revision FROM canvas_command_journal
         WHERE workspace_id=? AND project_id=? AND canvas_id=?`
      )
      .get(scope.workspaceId, scope.projectId, scope.canvasId) as
      | { revision: number | null }
      | undefined;
    return Number(row?.revision ?? 0);
  }

  journalEntryAt(scope: CanvasScopeKey, revision: number): CanvasJournalEntry | undefined {
    if (revision < 1) return undefined;
    const row = this.database
      .prepare(
        `SELECT entry_json FROM canvas_command_journal
         WHERE workspace_id=? AND project_id=? AND canvas_id=? AND revision=?`
      )
      .get(scope.workspaceId, scope.projectId, scope.canvasId, revision) as
      | { entry_json: string }
      | undefined;
    return row ? canvasJournalEntrySchema.parse(JSON.parse(row.entry_json)) : undefined;
  }

  getSnapshot(scope: CanvasScopeKey, revision?: number): CanvasSnapshotContent | undefined {
    const row =
      revision === undefined
        ? (this.database
            .prepare(
              `SELECT * FROM canvas_command_snapshots
               WHERE workspace_id=? AND project_id=? AND canvas_id=? AND integrity='verified'
               ORDER BY revision DESC LIMIT 1`
            )
            .get(scope.workspaceId, scope.projectId, scope.canvasId) as
            | Record<string, unknown>
            | undefined)
        : (this.database
            .prepare(
              `SELECT * FROM canvas_command_snapshots
               WHERE workspace_id=? AND project_id=? AND canvas_id=? AND revision=? AND integrity='verified'`
            )
            .get(scope.workspaceId, scope.projectId, scope.canvasId, revision) as
            | Record<string, unknown>
            | undefined);
    if (!row) return undefined;
    return this.snapshotFromRow(scope, row);
  }

  markSnapshotCorrupt(scope: CanvasScopeKey, revision: number): void {
    this.database
      .prepare(
        `UPDATE canvas_command_snapshots SET integrity='corrupt'
         WHERE workspace_id=? AND project_id=? AND canvas_id=? AND revision=?`
      )
      .run(scope.workspaceId, scope.projectId, scope.canvasId, revision);
  }

  reservePending(input: {
    scope: CanvasScopeKey;
    operationId: string;
    expectedRevision: number;
    intent: CanvasCommandIntent;
    intentDigest: string;
    actor: ActorRef;
  }): void {
    const at = this.clock().toISOString();
    this.database
      .prepare(
        `INSERT INTO canvas_command_pending(
          workspace_id,project_id,canvas_id,operation_id,expected_revision,
          intent_json,intent_digest,actor_kind,actor_id,actor_display_name,reserved_at,status
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?, 'applying')
        ON CONFLICT(workspace_id,project_id,canvas_id,operation_id) DO UPDATE SET
          status='applying', reserved_at=excluded.reserved_at`
      )
      .run(
        input.scope.workspaceId,
        input.scope.projectId,
        input.scope.canvasId,
        input.operationId,
        input.expectedRevision,
        JSON.stringify(input.intent),
        input.intentDigest,
        input.actor.kind,
        input.actor.id,
        input.actor.displayName ?? null,
        at
      );
  }

  clearPending(scope: CanvasScopeKey, operationId: string): void {
    this.database
      .prepare(
        `DELETE FROM canvas_command_pending
         WHERE workspace_id=? AND project_id=? AND canvas_id=? AND operation_id=?`
      )
      .run(scope.workspaceId, scope.projectId, scope.canvasId, operationId);
  }

  listNeedsRecovery(): Array<{
    scope: CanvasScopeKey;
    operationId: string;
    expectedRevision: number;
    intent: CanvasCommandIntent;
    intentDigest: string;
    actor: ActorRef;
  }> {
    const rows = this.database
      .prepare(
        `SELECT workspace_id,project_id,canvas_id,operation_id,expected_revision,
                intent_json,intent_digest,actor_kind,actor_id,actor_display_name
         FROM canvas_command_pending WHERE status IN ('applying','needs_recovery')`
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const kindRaw = String(row.actor_kind);
      const kind =
        kindRaw === "local_admin" || kindRaw === "system" || kindRaw === "human"
          ? kindRaw
          : "human";
      const actor: ActorRef = {
        kind,
        id: String(row.actor_id),
        ...(row.actor_display_name != null ? { displayName: String(row.actor_display_name) } : {})
      };
      return {
        scope: {
          workspaceId: String(row.workspace_id),
          projectId: String(row.project_id),
          canvasId: String(row.canvas_id)
        },
        operationId: String(row.operation_id),
        expectedRevision: Number(row.expected_revision),
        intent: JSON.parse(String(row.intent_json)) as CanvasCommandIntent,
        intentDigest: String(row.intent_digest),
        actor
      };
    });
  }

  hasPendingRecovery(scope: CanvasScopeKey): boolean {
    const row = this.database
      .prepare(
        `SELECT 1 AS present FROM canvas_command_pending
         WHERE workspace_id=? AND project_id=? AND canvas_id=?
           AND status IN ('applying','needs_recovery')
         LIMIT 1`
      )
      .get(scope.workspaceId, scope.projectId, scope.canvasId) as { present: number } | undefined;
    return row !== undefined;
  }

  markPendingNeedsRecovery(scope: CanvasScopeKey, operationId: string): void {
    this.database
      .prepare(
        `UPDATE canvas_command_pending SET status='needs_recovery'
         WHERE workspace_id=? AND project_id=? AND canvas_id=? AND operation_id=?`
      )
      .run(scope.workspaceId, scope.projectId, scope.canvasId, operationId);
  }

  /**
   * Persist accepted outcome atomically: journal entry, head, operation, snapshot, retention.
   */
  commitAccepted(input: {
    scope: CanvasScopeKey;
    operationId: string;
    intent: CanvasCommandIntent;
    intentDigest: string;
    actor: ActorRef;
    previousRevision: number;
    revision: number;
    contentDigest: string;
    digestManifest?: PackageSnapshotDigestManifest;
    sizeBytes?: number;
    packageSnapshotId?: string;
  }): CanvasCommandAccepted {
    return inWriteTransaction(this.database, () => this.commitAcceptedInCallerTransaction(input));
  }

  /** Storage adapter boundary for coordinated authority commits. */
  commitAcceptedInCallerTransaction(input: {
    scope: CanvasScopeKey;
    operationId: string;
    intent: CanvasCommandIntent;
    intentDigest: string;
    actor: ActorRef;
    previousRevision: number;
    revision: number;
    contentDigest: string;
    digestManifest?: PackageSnapshotDigestManifest;
    sizeBytes?: number;
    packageSnapshotId?: string;
  }): CanvasCommandAccepted {
    const acceptedAt = this.clock().toISOString();
    const entryId = `journal-${randomUUID()}`;
    const journalEntry = canvasJournalEntrySchema.parse({
      schemaVersion: "canvas-journal/v1",
      entryId,
      scope: {
        workspaceId: input.scope.workspaceId,
        projectId: input.scope.projectId,
        canvasId: input.scope.canvasId
      },
      revision: input.revision,
      previousRevision: input.previousRevision,
      operationId: input.operationId,
      intent: input.intent,
      intentDigest: input.intentDigest,
      contentDigest: input.contentDigest,
      actor: input.actor,
      acceptedAt
    });
    const accepted = canvasCommandAcceptedSchema.parse({
      type: "canvas.command.accepted",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      scope: journalEntry.scope,
      operationId: input.operationId,
      revision: input.revision,
      previousRevision: input.previousRevision,
      contentDigest: input.contentDigest,
      journalEntryId: entryId,
      actor: input.actor,
      acceptedAt,
      idempotentReplay: false
    });

    this.database
        .prepare(
          `INSERT INTO canvas_command_journal(
            workspace_id,project_id,canvas_id,entry_id,revision,previous_revision,operation_id,
            intent_json,intent_digest,content_digest,actor_kind,actor_id,actor_display_name,
            accepted_at,entry_json
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          input.scope.workspaceId,
          input.scope.projectId,
          input.scope.canvasId,
          entryId,
          input.revision,
          input.previousRevision,
          input.operationId,
          JSON.stringify(input.intent),
          input.intentDigest,
          input.contentDigest,
          input.actor.kind,
          input.actor.id,
          input.actor.displayName ?? null,
          acceptedAt,
          JSON.stringify(journalEntry)
        );

    this.database
        .prepare(
          `INSERT INTO canvas_command_heads(workspace_id,project_id,canvas_id,revision,content_digest,updated_at)
           VALUES(?,?,?,?,?,?)
           ON CONFLICT(workspace_id,project_id,canvas_id) DO UPDATE SET
             revision=excluded.revision,
             content_digest=excluded.content_digest,
             updated_at=excluded.updated_at`
        )
        .run(
          input.scope.workspaceId,
          input.scope.projectId,
          input.scope.canvasId,
          input.revision,
          input.contentDigest,
          acceptedAt
        );

    this.database
        .prepare(
          `INSERT INTO canvas_command_operations(
            workspace_id,project_id,canvas_id,operation_id,intent_digest,intent_json,outcome_json,
            accepted,revision,journal_entry_id,created_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          input.scope.workspaceId,
          input.scope.projectId,
          input.scope.canvasId,
          input.operationId,
          input.intentDigest,
          JSON.stringify(input.intent),
          JSON.stringify(accepted),
          1,
          input.revision,
          entryId,
          acceptedAt
        );

    const encoding = input.packageSnapshotId ? "package_snapshot_ref" : "digest_manifest_only";
    this.database
        .prepare(
          `INSERT INTO canvas_command_snapshots(
            workspace_id,project_id,canvas_id,revision,content_digest,created_at,
            package_snapshot_id,digest_manifest_json,size_bytes,encoding,integrity
          ) VALUES(?,?,?,?,?,?,?,?,?,?, 'verified')
          ON CONFLICT(workspace_id,project_id,canvas_id,revision) DO UPDATE SET
            content_digest=excluded.content_digest,
            created_at=excluded.created_at,
            package_snapshot_id=excluded.package_snapshot_id,
            digest_manifest_json=excluded.digest_manifest_json,
            size_bytes=excluded.size_bytes,
            encoding=excluded.encoding,
            integrity='verified'`
        )
        .run(
          input.scope.workspaceId,
          input.scope.projectId,
          input.scope.canvasId,
          input.revision,
          input.contentDigest,
          acceptedAt,
          input.packageSnapshotId ?? null,
          input.digestManifest ? JSON.stringify(input.digestManifest) : null,
          input.sizeBytes ?? null,
          encoding
        );

    this.trimJournal(input.scope);
    this.trimSnapshots(input.scope);
    this.clearPending(input.scope, input.operationId);

    return accepted;
  }

  storeRejected(input: {
    scope: CanvasScopeKey;
    operationId: string;
    intent: CanvasCommandIntent;
    intentDigest: string;
    rejected: CanvasCommandRejected;
  }): void {
    const at = this.clock().toISOString();
    // Only cache terminal non-CAS rejections for idempotency when intent matches.
    // stale_revision is not stored as a permanent outcome (revision moves).
    if (input.rejected.code === "stale_revision") return;
    inWriteTransaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO canvas_command_operations(
            workspace_id,project_id,canvas_id,operation_id,intent_digest,intent_json,outcome_json,
            accepted,revision,journal_entry_id,created_at
          ) VALUES(?,?,?,?,?,?,?,?,NULL,NULL,?)
          ON CONFLICT(workspace_id,project_id,canvas_id,operation_id) DO NOTHING`
        )
        .run(
          input.scope.workspaceId,
          input.scope.projectId,
          input.scope.canvasId,
          input.operationId,
          input.intentDigest,
          JSON.stringify(input.intent),
          JSON.stringify(canvasCommandRejectedSchema.parse(input.rejected)),
          0,
          at
        );
      this.clearPending(input.scope, input.operationId);
    });
  }

  ensureInitialHead(scope: CanvasScopeKey, contentDigest: string): CanvasHead {
    const existing = this.head(scope);
    if (existing.revision > 0) return existing;
    const at = this.clock().toISOString();
    inWriteTransaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO canvas_command_heads(workspace_id,project_id,canvas_id,revision,content_digest,updated_at)
           VALUES(?,?,?,0,?,?)
           ON CONFLICT(workspace_id,project_id,canvas_id) DO NOTHING`
        )
        .run(
          scope.workspaceId,
          scope.projectId,
          scope.canvasId,
          contentDigest === EMPTY_DIGEST ? EMPTY_DIGEST : contentDigest,
          at
        );
      if (contentDigest !== EMPTY_DIGEST) {
        this.database
          .prepare(
            `INSERT INTO canvas_command_snapshots(
              workspace_id,project_id,canvas_id,revision,content_digest,created_at,
              package_snapshot_id,digest_manifest_json,size_bytes,encoding,integrity
            ) VALUES(?,?,?,0,?,?,NULL,NULL,NULL,'digest_manifest_only','verified')
            ON CONFLICT(workspace_id,project_id,canvas_id,revision) DO NOTHING`
          )
          .run(scope.workspaceId, scope.projectId, scope.canvasId, contentDigest, at);
      }
    });
    return this.head(scope);
  }

  private trimJournal(scope: CanvasScopeKey): void {
    this.database
      .prepare(
        `DELETE FROM canvas_command_journal
         WHERE workspace_id=? AND project_id=? AND canvas_id=?
           AND revision NOT IN (
             SELECT revision FROM canvas_command_journal
             WHERE workspace_id=? AND project_id=? AND canvas_id=?
             ORDER BY revision DESC LIMIT ?
           )`
      )
      .run(
        scope.workspaceId,
        scope.projectId,
        scope.canvasId,
        scope.workspaceId,
        scope.projectId,
        scope.canvasId,
        this.maxJournalEntries
      );
  }

  private trimSnapshots(scope: CanvasScopeKey): void {
    this.database
      .prepare(
        `DELETE FROM canvas_command_snapshots
         WHERE workspace_id=? AND project_id=? AND canvas_id=?
           AND revision NOT IN (
             SELECT revision FROM canvas_command_snapshots
             WHERE workspace_id=? AND project_id=? AND canvas_id=?
             ORDER BY revision DESC LIMIT ?
           )`
      )
      .run(
        scope.workspaceId,
        scope.projectId,
        scope.canvasId,
        scope.workspaceId,
        scope.projectId,
        scope.canvasId,
        this.maxSnapshots
      );
  }

  private snapshotFromRow(
    scope: CanvasScopeKey,
    row: Record<string, unknown>
  ): CanvasSnapshotContent | undefined {
    try {
      const metadata = canvasSnapshotMetadataSchema.parse({
        schemaVersion: "canvas-snapshot/v1",
        scope: {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          canvasId: scope.canvasId
        },
        revision: Number(row.revision),
        contentDigest: String(row.content_digest),
        createdAt: String(row.created_at),
        packageSnapshotId:
          row.package_snapshot_id === null || row.package_snapshot_id === undefined
            ? undefined
            : String(row.package_snapshot_id),
        digestManifest:
          row.digest_manifest_json === null || row.digest_manifest_json === undefined
            ? undefined
            : JSON.parse(String(row.digest_manifest_json)),
        sizeBytes:
          row.size_bytes === null || row.size_bytes === undefined
            ? undefined
            : Number(row.size_bytes)
      });
      const encoding = String(row.encoding) as "package_snapshot_ref" | "digest_manifest_only";
      return canvasSnapshotContentSchema.parse({
        metadata,
        encoding,
        packageSnapshotId: metadata.packageSnapshotId,
        digestManifest: metadata.digestManifest
      });
    } catch {
      this.markSnapshotCorrupt(scope, Number(row.revision));
      return undefined;
    }
  }
}

export function rejectedOutcome(input: {
  projectId: string;
  canvasId: string;
  operationId: string;
  code: CanvasCommandRejected["code"];
  detail?: string;
  conflict?: CanvasCommandRejected["conflict"];
}): CanvasCommandRejected {
  return canvasCommandRejectedSchema.parse({
    type: "canvas.command.rejected",
    protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
    schemaVersion: "canvas-command/v1",
    projectId: input.projectId,
    canvasId: input.canvasId,
    operationId: input.operationId,
    code: input.code,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.conflict ? { conflict: input.conflict } : {})
  });
}
