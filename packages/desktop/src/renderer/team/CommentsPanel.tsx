import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { createTranslator } from "../i18n";
import { SafeMarkdown } from "../inspector/SafeMarkdown";
import type { StagedAttachment } from "../collaboration/attachmentUpload";
import type { CommentRowViewModel, CommentsPanelMode } from "../collaboration/commentViewModels";
import type { CommentComposerDraft } from "../collaboration/commentDraftStore";

export type CommentsPanelProps = {
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
  autoFocusComposer?: boolean;
  compact?: boolean;
  showHeader?: boolean;
  t: ReturnType<typeof createTranslator>;
  onDraftBodyChange: (body: string) => void;
  onShowPreviewChange: (show: boolean) => void;
  onLoadMore: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onSubmit: () => Promise<boolean>;
  onEdit: (commentId: string, body: string, expectedRevision: number) => Promise<boolean>;
  onTombstone: (commentId: string, expectedRevision: number) => Promise<boolean>;
  onStageFiles: (
    files: Array<{
      name: string;
      type: string;
      size: number;
      arrayBuffer: () => Promise<ArrayBuffer>;
    }>
  ) => Promise<void>;
  onCancelAttachment: (localId: string) => void;
  onRemoveAttachment: (localId: string) => void;
};

function ModeMessage({
  mode,
  t
}: {
  mode: CommentsPanelMode;
  t: ReturnType<typeof createTranslator>;
}) {
  switch (mode) {
    case "disconnected":
      return t("commentsDisconnected");
    case "connecting":
      return t("commentsConnecting");
    case "loading":
      return t("commentsLoading");
    case "offline":
      return t("commentsOffline");
    case "auth_expired":
      return t("commentsAuthExpired");
    case "forbidden":
      return t("commentsForbidden");
    case "error":
      return t("commentsError");
    case "empty":
      return t("commentsEmpty");
    default:
      return null;
  }
}

function CommentItem({
  row,
  submitting,
  t,
  onEdit,
  onTombstone
}: {
  row: CommentRowViewModel;
  submitting: boolean;
  t: ReturnType<typeof createTranslator>;
  onEdit: (commentId: string, body: string, expectedRevision: number) => Promise<boolean>;
  onTombstone: (commentId: string, expectedRevision: number) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(row.body ?? "");

  return (
    <article
      className="rounded-md border border-border/70 bg-card/40 p-2.5"
      data-testid="comments-item"
      data-comment-id={row.commentId}
      data-tombstoned={row.tombstoned ? "true" : "false"}
    >
      <header className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
        <span className="font-medium text-text-strong" data-testid="comments-item-author">
          {row.authorLabel}
          {row.isCurrentUser ? ` (${t("commentsYou")})` : ""}
        </span>
        <time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString()}</time>
        {row.workItemMissing ? (
          <span className="rounded bg-amber-500/15 px-1 py-0.5 text-amber-900 dark:text-amber-100">
            {t("commentsWorkItemMissing")}
          </span>
        ) : null}
        <span className="text-[10px] opacity-70">
          {t("commentsRevision")} {row.revision}
        </span>
      </header>

      {row.tombstoned ? (
        <p className="text-sm italic text-muted-foreground" data-testid="comments-item-tombstone">
          {row.tombstoneLabel}
        </p>
      ) : editing ? (
        <div className="flex flex-col gap-2">
          <Textarea
            aria-label={t("commentsEditAria")}
            className="min-h-20 text-sm"
            value={editBody}
            onChange={(event) => setEditBody(event.target.value)}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={submitting}
              data-testid="comments-edit-save"
              onClick={() => {
                void onEdit(row.commentId, editBody, row.revision).then((ok) => {
                  if (ok) setEditing(false);
                });
              }}
            >
              {t("commentsSaveEdit")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={submitting}
              onClick={() => {
                setEditing(false);
                setEditBody(row.body ?? "");
              }}
            >
              {t("commentsCancelEdit")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="text-sm" data-testid="comments-item-body">
          {row.body ? <SafeMarkdown markdown={row.body} /> : null}
        </div>
      )}

      {row.attachments.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1" data-testid="comments-item-attachments">
          {row.attachments.map((attachment) => (
            <li
              key={attachment.id}
              className="flex items-center gap-2 rounded border border-border/50 px-2 py-1 text-[11px] text-muted-foreground"
              data-testid="comments-attachment"
            >
              <span className="min-w-0 truncate font-medium text-text">
                {attachment.displayName}
              </span>
              <span>{attachment.mediaType}</span>
              <span>{attachment.sizeBytes} B</span>
              <span title={t("commentsAttachmentDigest")}>{attachment.digestShort}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {!row.tombstoned && (row.actions.canEdit || row.actions.canTombstone) ? (
        <div className="mt-2 flex gap-2">
          {row.actions.canEdit ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={submitting}
              data-testid="comments-edit"
              onClick={() => {
                setEditBody(row.body ?? "");
                setEditing(true);
              }}
            >
              {t("commentsEdit")}
            </Button>
          ) : null}
          {row.actions.canTombstone ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={submitting}
              data-testid="comments-tombstone"
              onClick={() => {
                if (window.confirm(t("commentsTombstoneConfirm"))) {
                  void onTombstone(row.commentId, row.revision);
                }
              }}
            >
              {t("commentsTombstone")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function CommentsPanel({
  mode,
  rows,
  draft,
  stagedAttachments,
  loading,
  loadingMore,
  hasMore,
  submitting,
  actionError,
  canCompose,
  autoFocusComposer = false,
  compact = false,
  showHeader = true,
  t,
  onDraftBodyChange,
  onShowPreviewChange,
  onLoadMore,
  onRefresh,
  onSubmit,
  onEdit,
  onTombstone,
  onStageFiles,
  onCancelAttachment,
  onRemoveAttachment
}: CommentsPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!autoFocusComposer || !canCompose || draft.showPreview) return;
    const frame = window.requestAnimationFrame(() => composerRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocusComposer, canCompose, draft.showPreview]);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const list = event.target.files;
    if (!list || list.length === 0) return;
    const files = Array.from(list).map((file) => ({
      name: file.name,
      type: file.type,
      size: file.size,
      arrayBuffer: () => file.arrayBuffer()
    }));
    void onStageFiles(files);
    event.target.value = "";
  };

  return (
    <section
      aria-label={t("commentsTitle")}
      className="flex min-h-0 flex-col gap-2"
      data-testid="comments-panel"
      data-mode={mode}
    >
      <div className="flex items-center justify-between gap-2">
        {showHeader ? (
          <div>
            <h3 className="text-sm font-semibold text-text-strong">{t("commentsTitle")}</h3>
            <p className="text-[11px] text-muted-foreground">{t("commentsSubtitle")}</p>
          </div>
        ) : (
          <span />
        )}
        <Button
          size="sm"
          variant="ghost"
          data-testid="comments-refresh"
          disabled={loading}
          onClick={() => void onRefresh()}
        >
          {t("commentsRefresh")}
        </Button>
      </div>

      <div aria-live="polite" className="sr-only" data-testid="comments-live-region">
        {actionError ?? (loading ? t("commentsLoading") : "")}
      </div>

      {actionError ? (
        <div
          className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
          data-testid="comments-error"
          role="alert"
        >
          {actionError}
          <Button
            className="ml-2"
            size="sm"
            variant="ghost"
            data-testid="comments-retry"
            onClick={() => void onRefresh()}
          >
            {t("commentsRetry")}
          </Button>
        </div>
      ) : null}

      <div
        className={
          compact
            ? "flex max-h-64 min-h-16 flex-col gap-2 overflow-y-auto pr-1 [scrollbar-gutter:stable]"
            : "flex max-h-72 min-h-24 flex-col gap-2 overflow-y-auto pr-1 [scrollbar-gutter:stable]"
        }
        data-testid="comments-list"
      >
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="comments-mode-message">
            <ModeMessage mode={mode} t={t} />
          </p>
        ) : (
          rows.map((row) => (
            <CommentItem
              key={row.commentId}
              row={row}
              submitting={submitting}
              t={t}
              onEdit={onEdit}
              onTombstone={onTombstone}
            />
          ))
        )}
        {hasMore ? (
          <Button
            size="sm"
            variant="outline"
            className="self-center"
            disabled={loadingMore}
            data-testid="comments-load-more"
            onClick={() => void onLoadMore()}
          >
            {loadingMore ? t("commentsLoading") : t("commentsLoadMore")}
          </Button>
        ) : null}
      </div>

      <div className="border-t border-border/70 pt-2" data-testid="comments-composer">
        <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px]">
          <span className="font-medium text-text-strong">{t("commentsCompose")}</span>
          <Button
            size="sm"
            variant={draft.showPreview ? "secondary" : "ghost"}
            data-testid="comments-preview-toggle"
            disabled={!canCompose}
            onClick={() => onShowPreviewChange(!draft.showPreview)}
          >
            {draft.showPreview ? t("commentsEditMode") : t("commentsPreview")}
          </Button>
        </div>
        {draft.showPreview ? (
          <div
            className="min-h-20 rounded border bg-background p-2 text-sm"
            data-testid="comments-preview"
          >
            {draft.body.trim() ? (
              <SafeMarkdown markdown={draft.body} />
            ) : (
              <span className="text-muted-foreground">{t("commentsPreviewEmpty")}</span>
            )}
          </div>
        ) : (
          <Textarea
            ref={composerRef}
            aria-label={t("commentsComposeAria")}
            className={compact ? "min-h-16 resize-none text-sm" : "min-h-20 resize-y text-sm"}
            data-testid="comments-body-input"
            disabled={!canCompose || submitting}
            placeholder={t("commentsPlaceholder")}
            value={draft.body}
            onChange={(event) => onDraftBodyChange(event.target.value)}
          />
        )}

        {stagedAttachments.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1" data-testid="comments-staged-attachments">
            {stagedAttachments.map((attachment) => (
              <li
                key={attachment.localId}
                className="flex items-center gap-2 text-[11px]"
                data-testid="comments-staged-attachment"
                data-phase={attachment.phase}
              >
                <span className="min-w-0 truncate font-medium">{attachment.displayName}</span>
                <span className="text-muted-foreground">
                  {attachment.phase === "ready"
                    ? t("commentsAttachmentReady")
                    : attachment.phase === "error"
                      ? t("commentsAttachmentError")
                      : t("commentsAttachmentUploading")}
                </span>
                {attachment.phase !== "ready" && attachment.phase !== "error" ? (
                  <span className="tabular-nums text-muted-foreground">
                    {Math.round(attachment.progress * 100)}%
                  </span>
                ) : null}
                {attachment.phase === "ready" || attachment.phase === "error" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="comments-remove-attachment"
                    onClick={() => onRemoveAttachment(attachment.localId)}
                  >
                    {t("commentsRemoveAttachment")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="comments-cancel-attachment"
                    onClick={() => onCancelAttachment(attachment.localId)}
                  >
                    {t("commentsCancelAttachment")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            multiple
            data-testid="comments-file-input"
            accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/markdown"
            onChange={handleFileChange}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!canCompose || submitting}
            data-testid="comments-attach"
            onClick={() => fileInputRef.current?.click()}
          >
            {t("commentsAttach")}
          </Button>
          <Button
            size="sm"
            disabled={!canCompose || submitting || !draft.body.trim()}
            data-testid="comments-submit"
            onClick={() => void onSubmit()}
          >
            {submitting ? t("commentsSubmitting") : t("commentsSubmit")}
          </Button>
        </div>
        {!canCompose ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("commentsComposeUnavailable")}
          </p>
        ) : null}
      </div>
    </section>
  );
}
