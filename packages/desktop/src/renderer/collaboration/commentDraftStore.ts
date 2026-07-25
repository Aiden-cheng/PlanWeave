import type { WorkItemRef } from "@planweave-ai/collaboration-contracts";
import { workItemKey } from "../../shared/collaborationReadModels.js";

export type CommentComposerDraft = {
  body: string;
  showPreview: boolean;
};

const draftsByWorkItem = new Map<string, CommentComposerDraft>();
let draftScopeKey: string | null = null;

function emptyDraft(): CommentComposerDraft {
  return { body: "", showPreview: false };
}

/**
 * Scope drafts to the active collaboration project/auth session.
 * Project switch, disconnect, or auth expiry must clear unsent bodies.
 */
export function setCommentDraftScope(scopeKey: string | null): void {
  if (draftScopeKey === scopeKey) return;
  draftsByWorkItem.clear();
  draftScopeKey = scopeKey;
}

export function getCommentDraft(workItem: WorkItemRef): CommentComposerDraft {
  const key = workItemKey(workItem);
  return draftsByWorkItem.get(key) ?? emptyDraft();
}

export function setCommentDraft(
  workItem: WorkItemRef,
  patch: Partial<CommentComposerDraft>
): CommentComposerDraft {
  const key = workItemKey(workItem);
  const next = { ...getCommentDraft(workItem), ...patch };
  draftsByWorkItem.set(key, next);
  return next;
}

export function clearCommentDraft(workItem: WorkItemRef): void {
  draftsByWorkItem.delete(workItemKey(workItem));
}

/** Test helper. */
export function resetCommentDraftStoreForTests(): void {
  draftsByWorkItem.clear();
  draftScopeKey = null;
}
