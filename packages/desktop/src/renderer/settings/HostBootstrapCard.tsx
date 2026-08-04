import { ClipboardCopyIcon, PlusIcon } from "lucide-react";
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
  onRetry
}: HostBootstrapCardProps) {
  const locale = t("hostAdminLocale");
  const resolvedHandoffState =
    handoffState !== "idle" ? handoffState : busy ? "pending" : handoff ? "ready" : "idle";
  const canCreate = Boolean(
    activeProfile?.hasOperatorCredential && activeProfile.endpoint && !busy
  );

  return (
    <Card data-testid="host-admin-bootstrap" data-handoff-state={resolvedHandoffState}>
      <CardHeader>
        <div className="flex size-9 items-center justify-center rounded-lg bg-state-selected-surface text-text-strong">
          <PlusIcon className="size-4" aria-hidden="true" />
        </div>
        <CardTitle>{t("hostAdminBootstrapTitle")}</CardTitle>
        <CardDescription>{t("hostAdminBootstrapDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!canCreate && !busy ? (
          <p className="rounded-lg border border-border/70 bg-surface-muted/30 px-3 py-2 text-xs leading-5 text-text-muted">
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
          <ClipboardCopyIcon data-icon="inline-start" />
          {busy ? t("hostAdminBootstrapPending") : t("hostAdminCreateGrant")}
        </Button>
        {resolvedHandoffState === "failed" && onRetry ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-fit"
            data-testid="host-admin-bootstrap-retry"
            disabled={!canCreate}
            onClick={onRetry}
          >
            {t("hostAdminBootstrapRetry")}
          </Button>
        ) : null}
        {handoff ? (
          <div
            className="grid gap-2 rounded-lg border border-emerald-500/35 bg-emerald-500/10 p-3"
            data-testid="host-admin-grant-once"
            role="status"
          >
            <div className="font-medium text-text-strong">{t("hostAdminGrantOnceTitle")}</div>
            <p className="text-xs leading-5 text-text-muted">
              {t("hostAdminGrantOnceWarning").replace(
                "{expiry}",
                formatDate(handoff.expiresAt, locale)
              )}
            </p>
            <p className="text-xs leading-5 text-text-muted">
              {t("hostAdminBootstrapHeartbeatNote")}
            </p>
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
          </div>
        ) : (
          <p className="text-xs leading-5 text-text-muted">{t("hostAdminBootstrapBoundary")}</p>
        )}
      </CardContent>
    </Card>
  );
}
