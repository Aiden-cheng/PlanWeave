import { randomUUID } from "node:crypto";
import { humanProjectIdSchema } from "../identity/schemas.js";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import { workItemKeyParts } from "../work/repository.js";
import { workItemRefSchema, type WorkItemRef } from "../work/schemas.js";
import { COMMENT_ACTIVITY_ERROR_MESSAGES, type CommentActivityErrorCode } from "./errors.js";
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

/**
 * Append-only activity projection store with source-action idempotency and outbox recovery.
 */
export class ActivityRepository {
  constructor(readonly database: SqliteDatabase) {}

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
         WHERE project_id=? AND source_kind=? AND source_id=?`
      )
      .get(
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
            activity_id,project_id,type,source_kind,source_id,
            summary_json,subjects_json,canvas_id,work_item_kind,work_item_key,occurred_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          parsed.activityId,
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
          outbox_id,project_id,source_kind,source_id,activity_json,created_at,projected_at
        ) VALUES (?,?,?,?,?,?, NULL)
        ON CONFLICT(project_id, source_kind, source_id) DO NOTHING`
      )
      .run(
        randomUUID(),
        parsed.projectId,
        parsed.source.kind,
        parsed.source.sourceId,
        JSON.stringify(parsed),
        createdAt
      );

    const result = this.insertIdempotentUnlocked(parsed);
    this.database
      .prepare(
        `UPDATE activity_projection_outbox
         SET projected_at=?
         WHERE project_id=? AND source_kind=? AND source_id=? AND projected_at IS NULL`
      )
      .run(parsed.occurredAt, parsed.projectId, parsed.source.kind, parsed.source.sourceId);
    return result;
  }

  enqueueAndProject(record: ActivityRecord, createdAt: string): ActivityInsertResult {
    return inWriteTransaction(this.database, () =>
      this.enqueueAndProjectUnlocked(record, createdAt)
    );
  }

  /** List unprojected outbox rows oldest-first for reconciliation. */
  listPendingOutbox(limit: number): Array<{
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
    const rows = this.database
      .prepare(
        `SELECT * FROM activity_projection_outbox
         WHERE projected_at IS NULL
         ORDER BY created_at ASC, outbox_id ASC
         LIMIT ?`
      )
      .all(limit) as OutboxRow[];
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
         WHERE project_id=? AND source_kind=? AND source_id=?`
      )
      .run(projectedAt, humanProjectIdSchema.parse(projectId), sourceKind, sourceId);
  }

  /**
   * Project any pending outbox rows (idempotent insert). Returns counts for recovery metrics.
   */
  reconcileOutbox(limit = 100): { processed: number; inserted: number; duplicates: number } {
    return inWriteTransaction(this.database, () => {
      const pending = this.listPendingOutbox(limit);
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
             WHERE project_id=? AND canvas_id=? AND work_item_kind=? AND work_item_key=?
               AND (
                 occurred_at < ?
                 OR (occurred_at = ? AND activity_id < ?)
               )
             ORDER BY occurred_at DESC, activity_id DESC
             LIMIT ?`
          )
          .all(
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
           WHERE project_id=? AND canvas_id=? AND work_item_kind=? AND work_item_key=?
           ORDER BY occurred_at DESC, activity_id DESC
           LIMIT ?`
        )
        .all(
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
           WHERE project_id=?
             AND (
               occurred_at < ?
               OR (occurred_at = ? AND activity_id < ?)
             )
           ORDER BY occurred_at DESC, activity_id DESC
           LIMIT ?`
        )
        .all(
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
         WHERE project_id=?
         ORDER BY occurred_at DESC, activity_id DESC
         LIMIT ?`
      )
      .all(projectId, limit) as ActivityRow[];
    return rows.map(toRecord);
  }
}
