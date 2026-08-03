import { randomUUID } from "node:crypto";
import { workspaceIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { humanProjectIdSchema } from "../identity/schemas.js";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import { workItemKeyParts } from "../work/repository.js";
import { workItemRefSchema, type WorkItemRef } from "../work/schemas.js";
import { COMMENT_ACTIVITY_ERROR_MESSAGES, type CommentActivityErrorCode } from "./errors.js";
import { ACTIVITY_RETENTION_MAX_AGE_MS } from "./limits.js";
import {
  activityIdSchema,
  activityRecordSchema,
  activitySourceKindSchema,
  type ActivityId,
  type ActivityListCursor,
  type ActivityRecord,
  type ActivitySourceKind
} from "./schemas.js";

export class ActivityRepositoryError extends Error {
  constructor(
    readonly code: CommentActivityErrorCode,
    message: string = COMMENT_ACTIVITY_ERROR_MESSAGES[code]
  ) {
    super(message);
    this.name = "ActivityRepositoryError";
  }
}

type ActivityRow = {
  activity_id: string;
  project_id: string;
  type: string;
  source_kind: string;
  source_id: string;
  summary_json: string;
  subjects_json: string;
  canvas_id: string | null;
  work_item_kind: string | null;
  work_item_key: string | null;
  occurred_at: string;
};

type OutboxRow = {
  outbox_id: string;
  project_id: string;
  source_kind: string;
  source_id: string;
  activity_json: string;
  activity_occurred_at: string | null;
  created_at: string;
  projected_at: string | null;
};

function workItemFromRow(row: ActivityRow): WorkItemRef | undefined {
  if (!row.canvas_id || !row.work_item_kind || !row.work_item_key) return undefined;
  return workItemRefSchema.parse(
    row.work_item_kind === "task"
      ? { kind: "task", canvasId: row.canvas_id, taskId: row.work_item_key }
      : { kind: "block", canvasId: row.canvas_id, blockRef: row.work_item_key }
  );
}

function toRecord(row: ActivityRow): ActivityRecord {
  const workItem = workItemFromRow(row);
  return activityRecordSchema.parse({
    activityId: row.activity_id,
    projectId: row.project_id,
    type: row.type,
    source: {
      kind: row.source_kind,
      sourceId: row.source_id
    },
    summary: JSON.parse(row.summary_json),
    subjects: JSON.parse(row.subjects_json),
    ...(workItem ? { workItem } : {}),
    occurredAt: row.occurred_at
  });
}

function workItemColumns(workItem: WorkItemRef | undefined): {
  canvas_id: string | null;
  work_item_kind: string | null;
  work_item_key: string | null;
} {
  if (!workItem) {
    return { canvas_id: null, work_item_kind: null, work_item_key: null };
  }
  const parts = workItemKeyParts(workItem);
  return {
    canvas_id: parts.canvasId,
    work_item_kind: parts.workItemKind,
    work_item_key: parts.workItemKey
  };
}

export type ActivityInsertResult =
  | { inserted: true; record: ActivityRecord }
  | { inserted: false; record: ActivityRecord; code: "activity_source_duplicate" };

export type ActivityRepositoryOptions = {
  onInsertedInTransaction?: (record: ActivityRecord) => void;
  workspaceId?: string;
};

/**
 * Append-only activity projection store with source-action idempotency and outbox recovery.
 */
export class ActivityRepository {
  private readonly configuredWorkspaceId: string | undefined;

  constructor(
    readonly database: SqliteDatabase,
    private readonly options: ActivityRepositoryOptions = {}
  ) {
    this.configuredWorkspaceId = options.workspaceId
      ? workspaceIdSchema.parse(options.workspaceId)
      : undefined;
  }

  private workspaceIdForProject(projectId: string): string {
    if (this.configuredWorkspaceId) return this.configuredWorkspaceId;
    const rows = this.database
      .prepare(
        `SELECT workspace_id FROM project_registry
         WHERE project_id=? AND revoked_at IS NULL ORDER BY workspace_id LIMIT 2`
      )
      .all(humanProjectIdSchema.parse(projectId)) as Array<{ workspace_id: string }>;
    if (rows.length > 1) throw new ActivityRepositoryError("activity_auth_forbidden");
    return rows[0] ? workspaceIdSchema.parse(rows[0].workspace_id) : "legacy";
  }

  allocateActivityId(): ActivityId {
    return activityIdSchema.parse(randomUUID());
  }

  getBySource(
    projectId: string,
    sourceKind: ActivitySourceKind,
    sourceId: string
  ): ActivityRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM activity_records
         WHERE workspace_id=? AND project_id=? AND source_kind=? AND source_id=?`
      )
      .get(
        this.workspaceIdForProject(projectId),
        humanProjectIdSchema.parse(projectId),
        activitySourceKindSchema.parse(sourceKind),
        sourceId
      ) as ActivityRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  /**
   * Insert activity if (projectId, source.kind, source.sourceId) is new.
   * Duplicate source is a no-op returning the existing row (idempotent).
   */
  insertIdempotentUnlocked(record: ActivityRecord): ActivityInsertResult {
    const parsed = activityRecordSchema.parse(record);
    const existing = this.getBySource(parsed.projectId, parsed.source.kind, parsed.source.sourceId);
    if (existing) {
      return { inserted: false, record: existing, code: "activity_source_duplicate" };
    }

    const cols = workItemColumns(parsed.workItem);
    try {
      this.database
        .prepare(
          `INSERT INTO activity_records(
            activity_id,workspace_id,project_id,type,source_kind,source_id,
            summary_json,subjects_json,canvas_id,work_item_kind,work_item_key,occurred_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          parsed.activityId,
          this.workspaceIdForProject(parsed.projectId),
          parsed.projectId,
          parsed.type,
          parsed.source.kind,
          parsed.source.sourceId,
          JSON.stringify(parsed.summary),
          JSON.stringify(parsed.subjects),
          cols.canvas_id,
          cols.work_item_kind,
          cols.work_item_key,
          parsed.occurredAt
        );
    } catch (error) {
      if (error instanceof Error && /UNIQUE/i.test(error.message)) {
        const raced = this.getBySource(
          parsed.projectId,
          parsed.source.kind,
          parsed.source.sourceId
        );
        if (raced) {
          return { inserted: false, record: raced, code: "activity_source_duplicate" };
        }
      }
      throw error;
    }
    const stored = this.getBySource(parsed.projectId, parsed.source.kind, parsed.source.sourceId);
    if (!stored) {
      throw new ActivityRepositoryError("activity_input_invalid", "Activity missing after insert.");
    }
    this.options.onInsertedInTransaction?.(stored);
    return { inserted: true, record: stored };
  }

  insertIdempotent(record: ActivityRecord): ActivityInsertResult {
    return inWriteTransaction(this.database, () => this.insertIdempotentUnlocked(record));
  }

  /**
   * Enqueue outbox + project activity in the caller's transaction (or open one).
   * Idempotent on source key for both outbox and activity rows.
   */
  enqueueAndProjectUnlocked(record: ActivityRecord, createdAt: string): ActivityInsertResult {
    const parsed = activityRecordSchema.parse(record);
    this.database
      .prepare(
        `INSERT INTO activity_projection_outbox(
          outbox_id,workspace_id,project_id,source_kind,source_id,activity_json,activity_occurred_at,
          created_at,projected_at
        ) VALUES (?,?,?,?,?,?,?,?, NULL)
        ON CONFLICT(workspace_id, project_id, source_kind, source_id) DO NOTHING`
      )
      .run(
        randomUUID(),
        this.workspaceIdForProject(parsed.projectId),
        parsed.projectId,
        parsed.source.kind,
        parsed.source.sourceId,
        JSON.stringify(parsed),
        parsed.occurredAt,
        createdAt
      );

    const result = this.insertIdempotentUnlocked(parsed);
    this.database
      .prepare(
        `UPDATE activity_projection_outbox
         SET projected_at=?
         WHERE workspace_id=? AND project_id=? AND source_kind=? AND source_id=? AND projected_at IS NULL`
      )
      .run(
        parsed.occurredAt,
        this.workspaceIdForProject(parsed.projectId),
        parsed.projectId,
        parsed.source.kind,
        parsed.source.sourceId
      );
    return result;
  }

  enqueueAndProject(record: ActivityRecord, createdAt: string): ActivityInsertResult {
    return inWriteTransaction(this.database, () =>
      this.enqueueAndProjectUnlocked(record, createdAt)
    );
  }

  /** List unprojected outbox rows oldest-first for reconciliation. */
  listPendingOutbox(
    limit: number,
    cutoff?: string
  ): Array<{
    outboxId: string;
    projectId: string;
    sourceKind: ActivitySourceKind;
    sourceId: string;
    activity: ActivityRecord;
    createdAt: string;
  }> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new ActivityRepositoryError("activity_input_invalid");
    }
    const rows = (
      this.configuredWorkspaceId
        ? cutoff
          ? this.database
              .prepare(
                `SELECT * FROM activity_projection_outbox
             WHERE workspace_id=? AND projected_at IS NULL AND activity_occurred_at >= ?
             ORDER BY created_at ASC, outbox_id ASC
             LIMIT ?`
              )
              .all(this.configuredWorkspaceId, cutoff, limit)
          : this.database
              .prepare(
                `SELECT * FROM activity_projection_outbox
             WHERE workspace_id=? AND projected_at IS NULL
             ORDER BY created_at ASC, outbox_id ASC
             LIMIT ?`
              )
              .all(this.configuredWorkspaceId, limit)
        : cutoff
          ? this.database
              .prepare(
                `SELECT * FROM activity_projection_outbox
                 WHERE projected_at IS NULL AND activity_occurred_at >= ?
                 ORDER BY created_at ASC, outbox_id ASC LIMIT ?`
              )
              .all(cutoff, limit)
          : this.database
              .prepare(
                `SELECT * FROM activity_projection_outbox
                 WHERE projected_at IS NULL
                 ORDER BY created_at ASC, outbox_id ASC LIMIT ?`
              )
              .all(limit)
    ) as OutboxRow[];
    return rows.map((row) => ({
      outboxId: row.outbox_id,
      projectId: row.project_id,
      sourceKind: activitySourceKindSchema.parse(row.source_kind),
      sourceId: row.source_id,
      activity: activityRecordSchema.parse(JSON.parse(row.activity_json)),
      createdAt: row.created_at
    }));
  }

  markOutboxProjected(
    projectId: string,
    sourceKind: string,
    sourceId: string,
    projectedAt: string
  ): void {
    this.database
      .prepare(
        `UPDATE activity_projection_outbox
         SET projected_at=?
         WHERE (workspace_id=? OR workspace_id IS NULL)
           AND project_id=? AND source_kind=? AND source_id=?`
      )
      .run(
        projectedAt,
        this.workspaceIdForProject(projectId),
        humanProjectIdSchema.parse(projectId),
        sourceKind,
        sourceId
      );
  }

  /**
   * Project any pending outbox rows (idempotent insert). Returns counts for recovery metrics.
   */
  reconcileOutbox(
    limit = 100,
    cutoff = new Date(Date.now() - ACTIVITY_RETENTION_MAX_AGE_MS).toISOString()
  ): { processed: number; inserted: number; duplicates: number } {
    return inWriteTransaction(this.database, () => {
      const pending = this.listPendingOutbox(limit, cutoff);
      let inserted = 0;
      let duplicates = 0;
      for (const item of pending) {
        const result = this.insertIdempotentUnlocked(item.activity);
        if (result.inserted) inserted += 1;
        else duplicates += 1;
        this.markOutboxProjected(
          item.projectId,
          item.sourceKind,
          item.sourceId,
          item.activity.occurredAt
        );
      }
      return { processed: pending.length, inserted, duplicates };
    });
  }

  /** Delete at most `limit` expired activity rows and outbox rows in one transaction. */
  purgeExpired(cutoff: string, limit = 100): { records: number; outbox: number } {
    if (Number.isNaN(Date.parse(cutoff)) || !Number.isSafeInteger(limit) || limit < 1) {
      throw new ActivityRepositoryError("activity_input_invalid");
    }
    return inWriteTransaction(this.database, () => {
      const workspaceClause = this.configuredWorkspaceId ? "workspace_id=? AND " : "";
      const scopeParameters = this.configuredWorkspaceId ? [this.configuredWorkspaceId] : [];
      const outbox = this.database
        .prepare(
          `DELETE FROM activity_projection_outbox
           WHERE outbox_id IN (
             SELECT outbox_id FROM activity_projection_outbox
             WHERE ${workspaceClause}activity_occurred_at < ?
             ORDER BY activity_occurred_at ASC, outbox_id ASC
             LIMIT ?
           )`
        )
        .run(...scopeParameters, cutoff, limit).changes;
      const records = this.database
        .prepare(
          `DELETE FROM activity_records
           WHERE activity_id IN (
             SELECT activity_id FROM activity_records
             WHERE ${workspaceClause}occurred_at < ?
             ORDER BY occurred_at ASC, activity_id ASC
             LIMIT ?
           )`
        )
        .run(...scopeParameters, cutoff, limit).changes;
      return { records, outbox };
    });
  }

  /**
   * Keyset list: occurredAt DESC, activityId DESC. Fetches exactly `limit` rows after cursor.
   */
  list(input: {
    projectId: string;
    workItem?: WorkItemRef;
    limit: number;
    cursor?: ActivityListCursor;
  }): ActivityRecord[] {
    const projectId = humanProjectIdSchema.parse(input.projectId);
    const limit = input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new ActivityRepositoryError("activity_input_invalid");
    }

    if (input.workItem) {
      const parts = workItemKeyParts(input.workItem);
      if (input.cursor) {
        const rows = this.database
          .prepare(
            `SELECT * FROM activity_records
             WHERE workspace_id=? AND project_id=? AND canvas_id=? AND work_item_kind=? AND work_item_key=?
               AND (
                 occurred_at < ?
                 OR (occurred_at = ? AND activity_id < ?)
               )
             ORDER BY occurred_at DESC, activity_id DESC
             LIMIT ?`
          )
          .all(
            this.workspaceIdForProject(projectId),
            projectId,
            parts.canvasId,
            parts.workItemKind,
            parts.workItemKey,
            input.cursor.occurredAt,
            input.cursor.occurredAt,
            input.cursor.activityId,
            limit
          ) as ActivityRow[];
        return rows.map(toRecord);
      }
      const rows = this.database
        .prepare(
          `SELECT * FROM activity_records
           WHERE workspace_id=? AND project_id=? AND canvas_id=? AND work_item_kind=? AND work_item_key=?
           ORDER BY occurred_at DESC, activity_id DESC
           LIMIT ?`
        )
        .all(
          this.workspaceIdForProject(projectId),
          projectId,
          parts.canvasId,
          parts.workItemKind,
          parts.workItemKey,
          limit
        ) as ActivityRow[];
      return rows.map(toRecord);
    }

    if (input.cursor) {
      const rows = this.database
        .prepare(
          `SELECT * FROM activity_records
           WHERE workspace_id=? AND project_id=?
             AND (
               occurred_at < ?
               OR (occurred_at = ? AND activity_id < ?)
             )
           ORDER BY occurred_at DESC, activity_id DESC
           LIMIT ?`
        )
        .all(
          this.workspaceIdForProject(projectId),
          projectId,
          input.cursor.occurredAt,
          input.cursor.occurredAt,
          input.cursor.activityId,
          limit
        ) as ActivityRow[];
      return rows.map(toRecord);
    }

    const rows = this.database
      .prepare(
        `SELECT * FROM activity_records
         WHERE workspace_id=? AND project_id=?
         ORDER BY occurred_at DESC, activity_id DESC
         LIMIT ?`
      )
      .all(this.workspaceIdForProject(projectId), projectId, limit) as ActivityRow[];
    return rows.map(toRecord);
  }
}
