import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";
import type {
  ActivityRowViewModel,
  CommentsPanelMode
} from "../collaboration/commentViewModels";

export type ActivityPanelProps = {
  mode: CommentsPanelMode;
  rows: ActivityRowViewModel[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  actionError: string | null;
  t: ReturnType<typeof createTranslator>;
  onLoadMore: () => Promise<void>;
  onRefresh: () => Promise<void>;
};

function modeMessage(mode: CommentsPanelMode, t: ReturnType<typeof createTranslator>): string {
  switch (mode) {
    case "disconnected":
      return t("activityDisconnected");
    case "connecting":
      return t("activityConnecting");
    case "loading":
      return t("activityLoading");
    case "offline":
      return t("activityOffline");
    case "auth_expired":
      return t("activityAuthExpired");
    case "forbidden":
      return t("activityForbidden");
    case "error":
      return t("activityError");
    case "empty":
      return t("activityEmpty");
    default:
      return "";
  }
}

export function ActivityPanel({
  mode,
  rows,
  loading,
  loadingMore,
  hasMore,
  actionError,
  t,
  onLoadMore,
  onRefresh
}: ActivityPanelProps) {
  return (
    <section
      aria-label={t("activityTitle")}
      className="flex min-h-0 flex-col gap-2"
      data-testid="activity-panel"
      data-mode={mode}
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-text-strong">{t("activityTitle")}</h3>
          <p className="text-[11px] text-muted-foreground">{t("activitySubtitle")}</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          data-testid="activity-refresh"
          disabled={loading}
          onClick={() => void onRefresh()}
        >
          {t("activityRefresh")}
        </Button>
      </div>

      <div aria-live="polite" className="sr-only" data-testid="activity-live-region">
        {actionError ?? (loading ? t("activityLoading") : "")}
      </div>

      {actionError ? (
        <div
          className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
          data-testid="activity-error"
          role="alert"
        >
          {actionError}
          <Button
            className="ml-2"
            size="sm"
            variant="ghost"
            data-testid="activity-retry"
            onClick={() => void onRefresh()}
          >
            {t("activityRetry")}
          </Button>
        </div>
      ) : null}

      <ul
        className="flex max-h-72 min-h-24 flex-col gap-1.5 overflow-y-auto pr-0.5 [scrollbar-gutter:stable]"
        data-testid="activity-list"
      >
        {rows.length === 0 ? (
          <li className="text-xs text-muted-foreground" data-testid="activity-mode-message">
            {modeMessage(mode, t)}
          </li>
        ) : (
          rows.map((row) => (
            <li
              key={row.activityId}
              className="rounded-md border border-border/60 bg-card/30 px-2.5 py-2"
              data-testid="activity-item"
              data-activity-id={row.activityId}
              data-source-kind={row.sourceKind}
              data-interactive="false"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                <span
                  className="rounded bg-state-selected-surface px-1.5 py-0.5 font-medium text-text-strong"
                  data-testid="activity-source"
                >
                  {t(row.sourceLabelKey)}
                </span>
                <time dateTime={row.occurredAt}>{new Date(row.occurredAt).toLocaleString()}</time>
                {row.workItemLabel ? <span>{row.workItemLabel}</span> : null}
              </div>
              <p className="mt-1 text-sm text-text" data-testid="activity-headline">
                {row.headline}
              </p>
            </li>
          ))
        )}
      </ul>

      {hasMore ? (
        <Button
          size="sm"
          variant="outline"
          className="self-center"
          disabled={loadingMore}
          data-testid="activity-load-more"
          onClick={() => void onLoadMore()}
        >
          {loadingMore ? t("activityLoading") : t("activityLoadMore")}
        </Button>
      ) : null}
    </section>
  );
}
