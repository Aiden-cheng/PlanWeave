import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { OperatorMemberSetupCodeHandoffView } from "../../shared/operatorControl";
import type { createTranslator } from "../i18n";

type MemberSetupCodeCardProps = {
  t: ReturnType<typeof createTranslator>;
  enabled: boolean;
  busy: boolean;
  handoff: OperatorMemberSetupCodeHandoffView | null;
  onCopy: () => void;
  onDismiss: () => void;
};

function formatDate(value: string, locale: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(locale);
}

/** Server-admin action for a one-time human device setup code; the secret stays in main. */
export function MemberSetupCodeCard({
  t,
  enabled,
  busy,
  handoff,
  onCopy,
  onDismiss
}: MemberSetupCodeCardProps) {
  return (
    <Card data-testid="host-admin-member-setup">
      <CardHeader>
        <CardTitle>{t("hostAdminMemberSetupTitle")}</CardTitle>
        <CardDescription>{t("hostAdminMemberSetupDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-text-muted">{t("hostAdminMemberSetupRoleNote")}</p>
        {handoff ? (
          <div
            className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm"
            data-testid="host-admin-member-setup-copied"
            role="status"
          >
            <div className="font-medium text-text-strong">
              {t("hostAdminMemberSetupCopied")}
            </div>
            <div className="mt-1 text-xs text-text-muted">
              {t("hostAdminMemberSetupWorkspace")}: {handoff.workspaceId}
            </div>
            <div className="text-xs text-text-muted">
              {t("hostAdminMemberSetupExpires")}: {formatDate(handoff.expiresAt, t("hostAdminLocale"))}
            </div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="mt-2"
              data-testid="host-admin-member-setup-dismiss"
              onClick={onDismiss}
            >
              {t("hostAdminMemberSetupDismiss")}
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            className="self-start"
            disabled={!enabled || busy}
            data-testid="host-admin-member-setup-copy"
            onClick={onCopy}
          >
            {busy ? t("hostAdminLoading") : t("hostAdminMemberSetupCopy")}
          </Button>
        )}
        {!enabled ? (
          <p className="text-xs text-text-muted">{t("hostAdminMemberSetupRequiresAdmin")}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
