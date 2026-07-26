import {
  humanObserverEventSchema,
  type HumanObserverEvent
} from "@planweave-ai/collaboration-contracts";
import { z } from "zod";
import type { SqliteDatabase } from "./sqlite.js";

const journalEventInputSchema = z
  .object({
    kind: humanObserverEventSchema.shape.kind,
    workItem: humanObserverEventSchema.shape.workItem,
    commentId: humanObserverEventSchema.shape.commentId,
    activityId: humanObserverEventSchema.shape.activityId,
    humanPrincipalId: humanObserverEventSchema.shape.humanPrincipalId,
    dispatchId: humanObserverEventSchema.shape.dispatchId,
    remoteRunStatus: humanObserverEventSchema.shape.remoteRunStatus
  })
  .strict();

export type HumanObserverJournalEventInput = z.input<typeof journalEventInputSchema>;

export type HumanObserverReplay =
  | { kind: "events"; headCursor: number; events: HumanObserverEvent[] }
  | {
      kind: "gap";
      reason: "retention_gap" | "cursor_ahead";
      headCursor: number;
      droppedThroughCursor?: number;
    };

export class HumanObserverJournal {
  private readonly subscribers = new Map<string, Set<(event: HumanObserverEvent) => void>>();

  constructor(
    private readonly database: SqliteDatabase,
    private readonly maxEventsPerProject: number,
    private readonly clock: () => Date = () => new Date()
  ) {
    if (!Number.isSafeInteger(maxEventsPerProject) || maxEventsPerProject < 1) {
      throw new Error("human_observer_retention_invalid");
    }
  }

  appendInCallerTransaction(
    projectId: string,
    rawInput: HumanObserverJournalEventInput,
    occurredAt = this.clock().toISOString()
  ): HumanObserverEvent {
    const input = journalEventInputSchema.parse(rawInput);
    const previousCursor = this.head(projectId);
    const result = this.database
      .prepare(
        `INSERT INTO human_observer_events(project_id,previous_cursor,event_json,occurred_at)
         VALUES (?,?,?,?)`
      )
      .run(projectId, previousCursor, JSON.stringify(input), occurredAt);
    const cursor = Number(result.lastInsertRowid);
    const event = humanObserverEventSchema.parse({
      type: "human.observer.event",
      protocolVersion: 1,
      cursor,
      previousCursor,
      occurredAt,
      ...input
    });
    this.database
      .prepare(
        `DELETE FROM human_observer_events
         WHERE project_id=? AND cursor NOT IN (
           SELECT cursor FROM human_observer_events
           WHERE project_id=? ORDER BY cursor DESC LIMIT ?
         )`
      )
      .run(projectId, projectId, this.maxEventsPerProject);
    queueMicrotask(() => {
      const committed = this.database
        .prepare(
          "SELECT 1 FROM human_observer_events WHERE project_id=? AND cursor=?"
        )
        .get(projectId, cursor);
      if (!committed) return;
      for (const subscriber of this.subscribers.get(projectId) ?? []) subscriber(event);
    });
    return event;
  }

  head(projectId: string): number {
    return Number(
      this.database
        .prepare("SELECT MAX(cursor) AS cursor FROM human_observer_events WHERE project_id=?")
        .get(projectId)?.cursor ?? 0
    );
  }

  replay(projectId: string, lastCursor: number): HumanObserverReplay {
    if (!Number.isSafeInteger(lastCursor) || lastCursor < 0) {
      throw new Error("human_observer_cursor_invalid");
    }
    const headCursor = this.head(projectId);
    if (lastCursor === 0) return { kind: "events", headCursor, events: [] };
    if (lastCursor > headCursor) return { kind: "gap", reason: "cursor_ahead", headCursor };
    const first = this.database
      .prepare(
        `SELECT previous_cursor FROM human_observer_events
         WHERE project_id=? ORDER BY cursor ASC LIMIT 1`
      )
      .get(projectId);
    const droppedThroughCursor = Number(first?.previous_cursor ?? 0);
    if (lastCursor < droppedThroughCursor) {
      return {
        kind: "gap",
        reason: "retention_gap",
        headCursor,
        droppedThroughCursor
      };
    }
    const rows = this.database
      .prepare(
        `SELECT cursor,previous_cursor,event_json,occurred_at
         FROM human_observer_events WHERE project_id=? AND cursor>?
         ORDER BY cursor ASC`
      )
      .all(projectId, lastCursor);
    return {
      kind: "events",
      headCursor,
      events: rows.map((row) =>
        humanObserverEventSchema.parse({
          type: "human.observer.event",
          protocolVersion: 1,
          cursor: row.cursor,
          previousCursor: row.previous_cursor,
          occurredAt: row.occurred_at,
          ...journalEventInputSchema.parse(JSON.parse(String(row.event_json)))
        })
      )
    };
  }

  subscribe(projectId: string, subscriber: (event: HumanObserverEvent) => void): () => void {
    const projectSubscribers = this.subscribers.get(projectId) ?? new Set();
    projectSubscribers.add(subscriber);
    this.subscribers.set(projectId, projectSubscribers);
    return () => {
      projectSubscribers.delete(subscriber);
      if (projectSubscribers.size === 0) this.subscribers.delete(projectId);
    };
  }
}
