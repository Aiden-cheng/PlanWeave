import type {
  ActivityId,
  ActivityListCursor,
  ActivityRecord,
  CommentId,
  CommentListCursor,
  CommentRecord
} from "./schemas.js";
import { activityListCursorSchema, commentListCursorSchema } from "./schemas.js";

/**
 * Comment thread order: createdAt ASC, commentId ASC (stable chronological).
 * Returns negative if a < b, zero if equal, positive if a > b.
 */
export function compareCommentOrder(
  a: { createdAt: string; commentId: string },
  b: { createdAt: string; commentId: string }
): number {
  const timeA = Date.parse(a.createdAt);
  const timeB = Date.parse(b.createdAt);
  if (timeA !== timeB) return timeA < timeB ? -1 : 1;
  if (a.commentId === b.commentId) return 0;
  return a.commentId < b.commentId ? -1 : 1;
}

/** True when item sorts strictly after the cursor in comment thread order. */
export function commentIsAfterCursor(
  item: { createdAt: string; commentId: string },
  cursor: CommentListCursor
): boolean {
  return compareCommentOrder(item, cursor) > 0;
}

export function commentCursorFromRecord(
  record: Pick<CommentRecord, "createdAt" | "commentId">
): CommentListCursor {
  return commentListCursorSchema.parse({
    createdAt: record.createdAt,
    commentId: record.commentId
  });
}

export function commentCursorFromIds(createdAt: string, commentId: CommentId): CommentListCursor {
  return commentListCursorSchema.parse({ createdAt, commentId });
}

/**
 * Activity feed order: occurredAt DESC, activityId DESC (newest first).
 * Returns negative if a should appear before b in the feed (i.e. a is newer).
 */
export function compareActivityOrder(
  a: { occurredAt: string; activityId: string },
  b: { occurredAt: string; activityId: string }
): number {
  const timeA = Date.parse(a.occurredAt);
  const timeB = Date.parse(b.occurredAt);
  if (timeA !== timeB) return timeA > timeB ? -1 : 1;
  if (a.activityId === b.activityId) return 0;
  return a.activityId > b.activityId ? -1 : 1;
}

/**
 * True when item sorts strictly after the cursor in activity feed order
 * (i.e. older / lower id than the cursor, for the next page of a DESC feed).
 */
export function activityIsAfterCursor(
  item: { occurredAt: string; activityId: string },
  cursor: ActivityListCursor
): boolean {
  return compareActivityOrder(item, cursor) > 0;
}

export function activityCursorFromRecord(
  record: Pick<ActivityRecord, "occurredAt" | "activityId">
): ActivityListCursor {
  return activityListCursorSchema.parse({
    occurredAt: record.occurredAt,
    activityId: record.activityId
  });
}

export function activityCursorFromIds(
  occurredAt: string,
  activityId: ActivityId
): ActivityListCursor {
  return activityListCursorSchema.parse({ occurredAt, activityId });
}

/**
 * Build nextCursor after a page. Returns null when the page is not full
 * (caller already applied limit+1 fetch or knows there is no more data).
 */
export function nextCommentCursor(
  pageItems: ReadonlyArray<Pick<CommentRecord, "createdAt" | "commentId">>,
  limit: number
): CommentListCursor | null {
  if (pageItems.length === 0 || pageItems.length < limit) return null;
  const last = pageItems[pageItems.length - 1];
  return commentCursorFromRecord(last);
}

export function nextActivityCursor(
  pageItems: ReadonlyArray<Pick<ActivityRecord, "occurredAt" | "activityId">>,
  limit: number
): ActivityListCursor | null {
  if (pageItems.length === 0 || pageItems.length < limit) return null;
  const last = pageItems[pageItems.length - 1];
  return activityCursorFromRecord(last);
}
