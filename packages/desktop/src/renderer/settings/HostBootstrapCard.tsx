import { ClipboardCopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  HOST_CREDENTIAL_LIFETIME_DAY_OPTIONS,
  hostCredentialLifetimeDaysSchema,
  type HostCredentialLifetimeDays
} from "@planweave-ai/agent-host-protocol";
import type {
  OperatorHostBootstrapHandoffView,
  OperatorProfileView
} from "../../shared/operatorControl";
import type { createTranslator } from "../i18n";

type HostBootstrapCardProps = {
  activeProfile: OperatorProfileView | null;
  busy: boolean;
  credentialLifetimeDays: HostCredentialLifetimeDays;
  copyBootstrapHandoff: () => Promise<OperatorHostBootstrapHandoffView | null>;
  dismissHandoff: () => void;
  handoff: OperatorHostBootstrapHandoffView | null;
  t: ReturnType<typeof createTranslator>;
  handoffState?: "idle" | "pending" | "ready" | "failed" | "expired" | "revoked";
  onRetry?: () => void;
  setCredentialLifetimeDays: (days: HostCredentialLifetimeDays) => void;
};

function formatDate(value: string, locale: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(locale);
}

export function HostBootstrapCard({
  activeProfile,
  busy,
  copyBootstrapHandoff,
  credentialLifetimeDays,
  dismissHandoff,
  handoff,
  t,
  handoffState = "idle",
  onRetry,
  setCredentialLifetimeDays
}: HostBootstrapCardProps) {
  const locale = t("hostAdminLocale");
  const resolvedHandoffState =
    handoffState !== "idle" ? handoffState : busy ? "pending" : handoff ? "ready" : "idle";
  const canCreate = Boolean(
    activeProfile?.hasOperatorCredential && activeProfile.endpoint && !busy
  );

  return (
    <section
      className="py-8"
      data-testid="host-admin-bootstrap"
      data-handoff-state={resolvedHandoffState}
    >
      <div className="max-w-3xl">
        <h2 className="text-lg font-semibold tracking-[-0.01em] text-text-strong">
          {t("hostAdminBootstrapTitle")}
        </h2>
        <p className="mt-1 text-sm leading-6 text-text-muted">
          {t("hostAdminBootstrapDescription")}
        </p>
      </div>
      <div className="mt-5 grid max-w-3xl gap-3">
        {!canCreate && !busy ? (
          <div className="max-w-2xl border-l-2 border-border pl-3">
            <p className="text-sm font-medium text-text-strong">
              {t("hostAdminBootstrapUnavailableTitle")}
            </p>
            <p className="mt-1 text-xs leading-5 text-text-muted">
              {t("hostAdminBootstrapSecureCoordinator")}
            </p>
          </div>
        ) : (
          <>
            <label className="grid w-fit gap-1 text-xs text-text-muted">
              <span>{t("hostAdminCredentialLifetime")}</span>
              <select
                className="h-9 min-w-40 rounded-md border border-input bg-background px-3 text-sm text-text-strong shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="host-admin-credential-lifetime"
                aria-label={t("hostAdminCredentialLifetime")}
                disabled={busy}
                value={credentialLifetimeDays}
                onChange={(event) =>
                  setCredentialLifetimeDays(
                    hostCredentialLifetimeDaysSchema.parse(Number(event.currentTarget.value))
                  )
                }
              >
                {HOST_CREDENTIAL_LIFETIME_DAY_OPTIONS.map((days) => (
                  <option key={days} value={days}>
                    {t("hostAdminCredentialLifetimeDays").replace("{days}", String(days))}
                  </option>
                ))}
              </select>
            </label>
            <p className="max-w-2xl text-xs leading-5 text-text-muted">
              {t("hostAdminCredentialLifetimeHint")}
            </p>
            <Button
              type="button"
              className="w-fit"
              data-testid="host-admin-create-grant"
              disabled={busy}
              onClick={() => void copyBootstrapHandoff()}
            >
              <ClipboardCopyIcon data-icon="inline-start" />
              {busy ? t("hostAdminBootstrapPending") : t("hostAdminCreateGrant")}
            </Button>
            {!handoff ? (
              <p className="max-w-2xl text-xs leading-5 text-text-muted">
                {t("hostAdminBootstrapPasteDestination")}
              </p>
            ) : null}
          </>
        )}
        {resolvedHandoffState === "failed" && onRetry && canCreate ? (
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
        {handoff && canCreate ? (
          <div
            className="grid gap-2 border-l-2 border-emerald-500 pl-3"
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
            <p className="text-xs leading-5 text-text-muted">
              {t("hostAdminCredentialExpiresAt").replace(
                "{expiry}",
                formatDate(handoff.credentialExpiresAt, locale)
              )}
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
        ) : null}
      </div>
    </section>
  );
}
