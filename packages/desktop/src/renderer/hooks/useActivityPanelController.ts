import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ACTIVITY_LIST_PAGE_DEFAULT,
  type ActivityRecord,
  type WorkItemRef
} from "@planweave-ai/collaboration-contracts";
import { collaborationBridge } from "../bridge";
import {
  buildActivityRowViewModel,
  resolveActivityPanelMode,
  type ActivityRowViewModel,
  type CommentsPanelMode
} from "../collaboration/commentViewModels";
import { collaborationErrorMessage } from "../collaboration/formatCollaborationError";
import type { createTranslator } from "../i18n";
import {
  workItemKey,
  type CollaborationBoundaryErrorView
} from "../../shared/collaborationReadModels.js";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import { useCollaborationReadModels } from "./useCollaborationReadModels";
import { useCollaborationStatus } from "./useCollaborationStatus";

export type UseActivityPanelControllerArgs = {
  /** When set, list activity for this work item; otherwise project-wide. */
  workItem?: WorkItemRef | null;
  open: boolean;
  api?: PlanWeaveCollaborationApi | null;
  t: ReturnType<typeof createTranslator>;
};

export type UseActivityPanelControllerResult = {
  mode: CommentsPanelMode;
  rows: ActivityRowViewModel[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  actionError: string | null;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
};

type ActivityCursor = { occurredAt: string; activityId: string };

function mapBoundaryError(error: unknown): CollaborationBoundaryErrorView {
  if (
    error &&
    typeof error === "object" &&
    "kind" in error &&
    "code" in error &&
    "message" in error &&
    "retryable" in error
  ) {
    return error as CollaborationBoundaryErrorView;
  }
  return {
    kind: "unknown",
    code: "collaboration_activity_error",
    message: error instanceof Error ? error.message : "activity_error",
    retryable: true
  };
}

/**
 * Lazy activity history for project or work-item scope.
 * Uses typed ActivityRecord summaries only — never ACP event streams.
 */
export function useActivityPanelController(
  args: UseActivityPanelControllerArgs
): UseActivityPanelControllerResult {
  const api = args.api === undefined ? collaborationBridge : args.api;
  const { status } = useCollaborationStatus({ api });
  const { snapshot } = useCollaborationReadModels({
    api,
    profileId: null,
    projectId: null,
    manageActiveProject: false
  });

  const sessionConnected =
    status?.session.phase === "connected" || status?.session.phase === "ready";
  const workKey = args.workItem ? workItemKey(args.workItem) : "project";

  const [items, setItems] = useState<ActivityRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<ActivityCursor | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const generationRef = useRef(0);

  const loadPage = useCallback(
    async (mode: "replace" | "append") => {
      if (!api || !args.open || !sessionConnected) return;
      const generation = generationRef.current;
      if (mode === "replace") setLoading(true);
      else setLoadingMore(true);
      setActionError(null);
      try {
        const page = await api.listCollaborationActivity({
          workItem: args.workItem ?? undefined,
          limit: ACTIVITY_LIST_PAGE_DEFAULT,
          cursor: mode === "append" && nextCursor ? nextCursor : undefined
        });
        if (generation !== generationRef.current) return;
        setItems((prev) => {
          if (mode === "replace") return page.items;
          const seen = new Set(prev.map((item) => item.activityId));
          const merged = [...prev];
          for (const item of page.items) {
            if (!seen.has(item.activityId)) merged.push(item);
          }
          merged.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
          return merged;
        });
        setNextCursor(page.nextCursor);
      } catch (error) {
        if (generation !== generationRef.current) return;
        setActionError(collaborationErrorMessage(mapBoundaryError(error)));
      } finally {
        if (generation === generationRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [api, args.open, args.workItem, nextCursor, sessionConnected]
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional scope-driven reload
  useEffect(() => {
    generationRef.current += 1;
    setItems([]);
    setNextCursor(null);
    setActionError(null);
    if (!args.open || !sessionConnected || !api) return;
    void loadPage("replace");
    // workKey/projectId remount the page; loadPage is stable enough via generation guard.
  }, [args.open, workKey, sessionConnected, api, snapshot.projectId]);

  // Merge hub project activity snapshots for the open scope (typed summaries only).
  // biome-ignore lint/correctness/useExhaustiveDependencies: updatedAt forces hub merge without churn
  useEffect(() => {
    if (!args.open) return;
    if (!snapshot.activity.length) return;
    setItems((prev) => {
      const filtered = args.workItem
        ? snapshot.activity.filter((record) => {
            const key = record.workItem
              ? workItemKey(record.workItem)
              : record.summary.workItem
                ? workItemKey(record.summary.workItem)
                : null;
            return key === workKey;
          })
        : snapshot.activity;
      if (filtered.length === 0) return prev;
      const byId = new Map(prev.map((item) => [item.activityId, item]));
      for (const item of filtered) {
        byId.set(item.activityId, item);
      }
      return [...byId.values()].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    });
  }, [args.open, args.workItem, snapshot.activity, snapshot.updatedAt, workKey]);

  const rows = useMemo(() => items.map(buildActivityRowViewModel), [items]);

  const mode = resolveActivityPanelMode({
    sessionConnected,
    sessionPhase: status?.session.phase ?? null,
    syncPhase: snapshot.syncPhase,
    loading,
    hasItems: rows.length > 0,
    lastErrorKind: snapshot.lastError?.kind ?? (actionError ? "error" : null)
  });

  const refresh = useCallback(async () => {
    generationRef.current += 1;
    setNextCursor(null);
    await loadPage("replace");
  }, [loadPage]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    await loadPage("append");
  }, [loadPage, loadingMore, nextCursor]);

  return {
    mode,
    rows,
    loading,
    loadingMore,
    hasMore: nextCursor != null,
    actionError,
    loadMore,
    refresh
  };
}
