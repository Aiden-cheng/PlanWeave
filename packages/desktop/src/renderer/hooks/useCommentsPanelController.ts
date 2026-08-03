import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  COMMENT_ATTACHMENTS_MAX_COUNT,
  COMMENT_LIST_PAGE_DEFAULT,
  type CommentDisplayProjection,
  type WorkItemRef
} from "@planweave-ai/collaboration-protocol";
import { collaborationBridge } from "../bridge";
import {
  createStagedAttachmentFromFile,
  uploadStagedAttachment,
  type StagedAttachment
} from "../collaboration/attachmentUpload";
import {
  clearCommentDraft,
  getCommentDraft,
  setCommentDraft,
  setCommentDraftScope,
  type CommentComposerDraft
} from "../collaboration/commentDraftStore";
import {
  buildCommentRowViewModel,
  resolveCommentsPanelMode,
  validateCommentBodyLength,
  type CommentRowViewModel,
  type CommentsPanelMode
} from "../collaboration/commentViewModels";
import { collaborationErrorMessage } from "../collaboration/formatCollaborationError";
import { resolveCurrentMembership } from "../collaboration/peopleViewModels";
import type { createTranslator } from "../i18n";
import {
  workItemKey,
  type CollaborationBoundaryErrorView
} from "../../shared/collaborationReadModels.js";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import { useCollaborationReadModels } from "./useCollaborationReadModels";
import { useCollaborationStatus } from "./useCollaborationStatus";
import { isCollaborationSessionConnected } from "../collaboration/sessionState";

export type UseCommentsPanelControllerArgs = {
  workItem: WorkItemRef | null;
  /** Lazy-load histories only while the surface is open. */
  open: boolean;
  api?: PlanWeaveCollaborationApi | null;
  t: ReturnType<typeof createTranslator>;
};

export type UseCommentsPanelControllerResult = {
  mode: CommentsPanelMode;
  rows: CommentRowViewModel[];
  draft: CommentComposerDraft;
  stagedAttachments: StagedAttachment[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  submitting: boolean;
  actionError: string | null;
  canCompose: boolean;
  setDraftBody: (body: string) => void;
  setShowPreview: (show: boolean) => void;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  submitComment: () => Promise<boolean>;
  editComment: (commentId: string, body: string, expectedRevision: number) => Promise<boolean>;
  tombstoneComment: (commentId: string, expectedRevision: number) => Promise<boolean>;
  stageFiles: (
    files: Array<{
      name: string;
      type: string;
      size: number;
      arrayBuffer: () => Promise<ArrayBuffer>;
    }>
  ) => Promise<void>;
  cancelAttachment: (localId: string) => void;
  removeAttachment: (localId: string) => void;
};

type CommentCursor = { createdAt: string; commentId: string };

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
    code: "collaboration_comment_error",
    message: error instanceof Error ? error.message : "comment_error",
    retryable: true
  };
}

/**
 * On-demand comments controller for one WorkItemRef.
 * Reuses the shared collaboration hub for identity/sync; history is lazy-loaded
 * and paginated with cursor load-more. Drafts are keyed by stable work item id.
 */
export function useCommentsPanelController(
  args: UseCommentsPanelControllerArgs
): UseCommentsPanelControllerResult {
  const api = args.api === undefined ? collaborationBridge : args.api;
  const { status } = useCollaborationStatus({ api });
  const { snapshot, controller } = useCollaborationReadModels({
    api,
    profileId: null,
    projectId: null,
    manageActiveProject: false
  });

  const activeProfile = useMemo(() => {
    if (!status?.activeProfileId) return null;
    return status.profiles.find((p) => p.profileId === status.activeProfileId) ?? null;
  }, [status]);

  const sessionConnected = isCollaborationSessionConnected(status);
  const currentMembership = resolveCurrentMembership({
    members: snapshot.members,
    status
  });
  const currentHumanPrincipalId =
    currentMembership?.humanPrincipalId ?? activeProfile?.humanPrincipalId ?? null;
  const currentUserIsOwner = currentMembership?.role === "owner";

  const scopeKey =
    sessionConnected && activeProfile
      ? `${activeProfile.profileId}:${activeProfile.projectId}`
      : null;

  useEffect(() => {
    setCommentDraftScope(scopeKey);
  }, [scopeKey]);

  const workKey = args.workItem ? workItemKey(args.workItem) : null;
  const [comments, setComments] = useState<CommentDisplayProjection[]>([]);
  const [nextCursor, setNextCursor] = useState<CommentCursor | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [draftTick, setDraftTick] = useState(0);
  const [stagedAttachments, setStagedAttachments] = useState<StagedAttachment[]>([]);
  const cancelledUploads = useRef(new Set<string>());
  const generationRef = useRef(0);

  useEffect(() => {
    if (!controller || !activeProfile || !sessionConnected) return;
    const current = controller.getSnapshot();
    if (current.profileId || current.projectId) return;
    void controller.setActiveProject({
      profileId: activeProfile.profileId,
      projectId: activeProfile.projectId
    });
  }, [activeProfile, controller, sessionConnected]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: workKey remounts draft identity
  const draft = useMemo(() => {
    void draftTick;
    return args.workItem ? getCommentDraft(args.workItem) : { body: "", showPreview: false };
  }, [args.workItem, draftTick, workKey]);

  const canMutate =
    sessionConnected &&
    (snapshot.syncPhase === "ready" ||
      snapshot.syncPhase === "degraded" ||
      snapshot.syncPhase === "stale_conflict" ||
      snapshot.syncPhase === "loading");

  const loadPage = useCallback(
    async (mode: "replace" | "append") => {
      if (!api || !args.workItem || !args.open || !sessionConnected) return;
      const generation = generationRef.current;
      if (mode === "replace") setLoading(true);
      else setLoadingMore(true);
      setActionError(null);
      try {
        if (controller && mode === "replace") {
          await controller.trackWorkItemComments(args.workItem);
        }
        const page = await api.listCollaborationComments({
          workItem: args.workItem,
          limit: COMMENT_LIST_PAGE_DEFAULT,
          includeTombstoned: true,
          cursor: mode === "append" && nextCursor ? nextCursor : undefined
        });
        if (generation !== generationRef.current) return;
        setComments((prev) => {
          if (mode === "replace") return page.items;
          const seen = new Set(prev.map((c) => c.commentId));
          const merged = [...prev];
          for (const item of page.items) {
            if (!seen.has(item.commentId)) merged.push(item);
          }
          merged.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
    [api, args.open, args.workItem, controller, nextCursor, sessionConnected]
  );

  // Intentionally reset when work item / open / connection changes.
  // loadPage depends on nextCursor; initial replace must not re-fire when cursor advances.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope-driven reload only
  useEffect(() => {
    generationRef.current += 1;
    setComments([]);
    setNextCursor(null);
    setStagedAttachments([]);
    cancelledUploads.current.clear();
    setActionError(null);
    if (!args.open || !args.workItem || !sessionConnected || !api) return;
    void loadPage("replace");
    // Intentionally reset when work item / open / connection changes.
    // loadPage depends on nextCursor; initial replace must not re-fire when cursor advances.
  }, [args.open, workKey, sessionConnected, api, scopeKey]);

  // Reconcile hub invalidations (first page) into the open list without dropping loaded history
  // when the hub page is a subset — full refresh only when snapshot comments advance.
  // biome-ignore lint/correctness/useExhaustiveDependencies: updatedAt forces hub merge
  useEffect(() => {
    if (!args.open || !workKey) return;
    const hubItems = snapshot.commentsByWorkItem[workKey];
    if (!hubItems || hubItems.length === 0) return;
    setComments((prev) => {
      const byId = new Map(prev.map((c) => [c.commentId, c]));
      for (const item of hubItems) {
        byId.set(item.commentId, item);
      }
      return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    });
  }, [args.open, workKey, snapshot.commentsByWorkItem, snapshot.updatedAt]);

  const rows = useMemo(
    () =>
      comments.map((comment) =>
        buildCommentRowViewModel({
          comment,
          currentHumanPrincipalId,
          currentUserIsOwner,
          canMutate,
          removedMemberLabel: args.t("commentsRemovedMember"),
          tombstonedLabel: args.t("commentsTombstoned")
        })
      ),
    [args.t, canMutate, comments, currentHumanPrincipalId, currentUserIsOwner]
  );

  const mode = resolveCommentsPanelMode({
    sessionConnected,
    sessionPhase: status?.session.phase ?? null,
    syncPhase: snapshot.syncPhase,
    loading,
    hasComments: rows.length > 0,
    lastErrorKind: snapshot.lastError?.kind ?? (actionError ? "error" : null)
  });

  const setDraftBody = useCallback(
    (body: string) => {
      if (!args.workItem) return;
      setCommentDraft(args.workItem, { body });
      setDraftTick((v) => v + 1);
    },
    [args.workItem]
  );

  const setShowPreview = useCallback(
    (show: boolean) => {
      if (!args.workItem) return;
      setCommentDraft(args.workItem, { showPreview: show });
      setDraftTick((v) => v + 1);
    },
    [args.workItem]
  );

  const refresh = useCallback(async () => {
    generationRef.current += 1;
    setNextCursor(null);
    await loadPage("replace");
  }, [loadPage]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    await loadPage("append");
  }, [loadPage, loadingMore, nextCursor]);

  const submitComment = useCallback(async () => {
    if (!api || !args.workItem || !controller || !canMutate) return false;
    const bodyCheck = validateCommentBodyLength(draft.body.trim());
    if (!bodyCheck.ok) {
      setActionError(args.t("commentsBodyInvalid"));
      return false;
    }
    const ready = stagedAttachments.filter((a) => a.phase === "ready" && a.input);
    if (
      stagedAttachments.some(
        (a) => a.phase === "creating" || a.phase === "uploading" || a.phase === "finalizing"
      )
    ) {
      setActionError(args.t("commentsAttachmentsPending"));
      return false;
    }
    if (ready.length > COMMENT_ATTACHMENTS_MAX_COUNT) {
      setActionError(args.t("commentsAttachmentsTooMany"));
      return false;
    }
    setSubmitting(true);
    setActionError(null);
    try {
      const result = await controller.createComment({
        workItem: args.workItem,
        body: draft.body.trim(),
        attachments: ready.map((a) => a.input!)
      });
      if (!result) {
        setActionError(
          collaborationErrorMessage(snapshot.lastError) || args.t("commentsSubmitFailed")
        );
        return false;
      }
      setComments((prev) => {
        const next = prev.filter((c) => c.commentId !== result.commentId);
        next.push(result);
        next.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return next;
      });
      clearCommentDraft(args.workItem);
      setStagedAttachments([]);
      setDraftTick((v) => v + 1);
      return true;
    } catch (error) {
      setActionError(collaborationErrorMessage(mapBoundaryError(error)));
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [
    api,
    args.t,
    args.workItem,
    canMutate,
    controller,
    draft.body,
    snapshot.lastError,
    stagedAttachments
  ]);

  const editComment = useCallback(
    async (commentId: string, body: string, expectedRevision: number) => {
      if (!controller || !canMutate) return false;
      const bodyCheck = validateCommentBodyLength(body.trim());
      if (!bodyCheck.ok) {
        setActionError(args.t("commentsBodyInvalid"));
        return false;
      }
      setSubmitting(true);
      setActionError(null);
      try {
        const result = await controller.editComment({
          commentId,
          body: body.trim(),
          expectedRevision
        });
        if (!result) {
          setActionError(
            collaborationErrorMessage(snapshot.lastError) || args.t("commentsEditFailed")
          );
          return false;
        }
        setComments((prev) => prev.map((c) => (c.commentId === result.commentId ? result : c)));
        return true;
      } catch (error) {
        setActionError(collaborationErrorMessage(mapBoundaryError(error)));
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [args.t, canMutate, controller, snapshot.lastError]
  );

  const tombstoneComment = useCallback(
    async (commentId: string, expectedRevision: number) => {
      if (!controller || !canMutate) return false;
      setSubmitting(true);
      setActionError(null);
      try {
        const result = await controller.tombstoneComment({
          commentId,
          expectedRevision
        });
        if (!result) {
          setActionError(
            collaborationErrorMessage(snapshot.lastError) || args.t("commentsTombstoneFailed")
          );
          return false;
        }
        setComments((prev) => prev.map((c) => (c.commentId === result.commentId ? result : c)));
        return true;
      } catch (error) {
        setActionError(collaborationErrorMessage(mapBoundaryError(error)));
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [args.t, canMutate, controller, snapshot.lastError]
  );

  const stageFiles = useCallback(
    async (
      files: Array<{
        name: string;
        type: string;
        size: number;
        arrayBuffer: () => Promise<ArrayBuffer>;
      }>
    ) => {
      if (!api || !canMutate) {
        setActionError(args.t("commentsOffline"));
        return;
      }
      const remaining =
        COMMENT_ATTACHMENTS_MAX_COUNT -
        stagedAttachments.filter((a) => a.phase !== "cancelled" && a.phase !== "error").length;
      if (remaining <= 0) {
        setActionError(args.t("commentsAttachmentsTooMany"));
        return;
      }
      const selected = files.slice(0, remaining);
      for (const file of selected) {
        const created = createStagedAttachmentFromFile(file);
        if (!created.ok) {
          setActionError(args.t("commentsAttachmentInvalid"));
          continue;
        }
        const localId = created.staged.localId;
        setStagedAttachments((prev) => [...prev, created.staged]);
        void (async () => {
          try {
            const buffer = new Uint8Array(await file.arrayBuffer());
            await uploadStagedAttachment({
              api,
              staged: created.staged,
              bytes: buffer,
              isCancelled: () => cancelledUploads.current.has(localId),
              onProgress: (next) => {
                setStagedAttachments((prev) =>
                  prev.map((item) => (item.localId === localId ? next : item))
                );
              }
            });
          } catch {
            setStagedAttachments((prev) =>
              prev.map((item) =>
                item.localId === localId
                  ? {
                      ...item,
                      phase: "error",
                      errorMessage: args.t("commentsAttachmentUploadFailed"),
                      progress: 0
                    }
                  : item
              )
            );
          }
        })();
      }
    },
    [api, args.t, canMutate, stagedAttachments]
  );

  const cancelAttachment = useCallback((localId: string) => {
    cancelledUploads.current.add(localId);
    setStagedAttachments((prev) =>
      prev.map((item) =>
        item.localId === localId
          ? { ...item, phase: "cancelled", progress: 0, errorMessage: null }
          : item
      )
    );
  }, []);

  const removeAttachment = useCallback((localId: string) => {
    cancelledUploads.current.add(localId);
    setStagedAttachments((prev) => prev.filter((item) => item.localId !== localId));
  }, []);

  return {
    mode,
    rows,
    draft,
    stagedAttachments: stagedAttachments.filter((a) => a.phase !== "cancelled"),
    loading,
    loadingMore,
    hasMore: nextCursor != null,
    submitting,
    actionError,
    canCompose: canMutate && Boolean(args.workItem) && sessionConnected,
    setDraftBody,
    setShowPreview,
    loadMore,
    refresh,
    submitComment,
    editComment,
    tombstoneComment,
    stageFiles,
    cancelAttachment,
    removeAttachment
  };
}
