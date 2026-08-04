import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  OperatorHostBootstrapHandoffView,
  OperatorProfileView
} from "../../shared/operatorControl";
import type { createTranslator } from "../i18n";

type HostBootstrapCardProps = {
  activeProfile: OperatorProfileView | null;
  busy: boolean;
  copyBootstrapHandoff: () => Promise<OperatorHostBootstrapHandoffView | null>;
  dismissHandoff: () => void;
  handoff: OperatorHostBootstrapHandoffView | null;
  t: ReturnType<typeof createTranslator>;
  handoffState?: "idle" | "pending" | "ready" | "failed" | "expired" | "revoked";
  handoffError?: string | null;
  onRetry?: () => void;
};

function formatDate(value: string, locale: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(locale);
}

export function HostBootstrapCard({
  activeProfile,
  busy,
  copyBootstrapHandoff,
  dismissHandoff,
  handoff,
  t,
  handoffState = "idle",
  handoffError = null,
  onRetry
}: HostBootstrapCardProps) {
  const locale = t("hostAdminLocale");
  const resolvedHandoffState =
    handoffState !== "idle"
      ? handoffState
      : busy
        ? "pending"
        : handoff
          ? "ready"
          : handoffError
            ? "failed"
            : "idle";
  const canCreate = Boolean(
    activeProfile?.hasOperatorCredential && activeProfile.endpoint && !busy
  );

  return (
    <Card data-testid="host-admin-bootstrap" data-handoff-state={resolvedHandoffState}>
      <CardHeader>
        <CardTitle>{t("hostAdminBootstrapTitle")}</CardTitle>
        <CardDescription>{t("hostAdminBootstrapDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-xs text-text-muted">{t("hostAdminBootstrapBoundary")}</p>
        <div
          className="rounded-md border border-border/70 bg-muted/20 px-2 py-1.5 text-xs"
          data-testid="host-admin-bootstrap-status"
          data-state={resolvedHandoffState}
          role="status"
        >
          {resolvedHandoffState === "pending"
            ? t("hostAdminBootstrapPending")
            : resolvedHandoffState === "ready"
              ? t("hostAdminBootstrapReady")
              : resolvedHandoffState === "failed"
                ? t("hostAdminBootstrapFailed")
                : resolvedHandoffState === "expired"
                  ? t("hostAdminBootstrapExpired")
                  : resolvedHandoffState === "revoked"
                    ? t("hostAdminBootstrapRevoked")
                    : t("hostAdminBootstrapIdle")}
          {handoffError ? (
            <div className="mt-1 text-destructive" data-testid="host-admin-bootstrap-error">
              {handoffError}
            </div>
          ) : null}
          {resolvedHandoffState === "failed" && onRetry ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-2"
              data-testid="host-admin-bootstrap-retry"
              disabled={busy}
              onClick={onRetry}
            >
              {t("hostAdminBootstrapRetry")}
            </Button>
          ) : null}
        </div>
        <div className="rounded-md border border-border/70 p-3 text-xs text-text-muted">
          <code>planweave agent-host enroll &lt;handoff&gt;</code>
          <p className="mt-2">{t("hostAdminBootstrapCodexPreset")}</p>
        </div>
        {!activeProfile?.endpoint ? (
          <p
            className="text-xs text-destructive"
            role="alert"
            data-testid="host-admin-bootstrap-validation"
          >
            {t("hostAdminBootstrapSecureCoordinator")}
          </p>
        ) : null}
        <Button
          type="button"
          className="w-fit"
          data-testid="host-admin-create-grant"
          disabled={!canCreate}
          onClick={() => void copyBootstrapHandoff()}
        >
          {t("hostAdminCreateGrant")}
        </Button>
        {handoff ? (
          <div
            className="grid gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3"
            data-testid="host-admin-grant-once"
            role="alertdialog"
          >
            <div className="font-medium text-text-strong">{t("hostAdminGrantOnceTitle")}</div>
            <p className="text-xs text-text-muted">
              {t("hostAdminGrantOnceWarning").replace(
                "{expiry}",
                formatDate(handoff.expiresAt, locale)
              )}
            </p>
            <code className="text-xs">{handoff.commandPreview}</code>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="w-fit"
              data-testid="host-admin-close-grant"
              onClick={dismissHandoff}
            >
              {t("hostAdminCloseGrant")}
            </Button>
            <p className="text-xs text-text-muted">{t("hostAdminBootstrapHeartbeatNote")}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
