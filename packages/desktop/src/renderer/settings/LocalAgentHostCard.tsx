import { useEffect, useState } from "react";
import { LaptopIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  OperatorLocalAgentHostStatus,
  OperatorProfileView
} from "../../shared/operatorControl";
import type { createTranslator } from "../i18n";

type LocalAgentHostCardProps = {
  activeProfile: OperatorProfileView | null;
  busy: boolean;
  loading: boolean;
  status: OperatorLocalAgentHostStatus | null;
  register: (profileIds: readonly string[]) => Promise<OperatorLocalAgentHostStatus | null>;
  enrollFromClipboard: (
    profileIds: readonly string[]
  ) => Promise<OperatorLocalAgentHostStatus | null>;
  t: ReturnType<typeof createTranslator>;
};

export function LocalAgentHostCard({
  activeProfile,
  busy,
  loading,
  status,
  register,
  enrollFromClipboard,
  t
}: LocalAgentHostCardProps) {
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    setSelected(
      status?.agents.filter((agent) => agent.exposed).map((agent) => agent.profileId) ?? []
    );
  }, [status]);

  const hasDirectRegistration = Boolean(
    status?.supported &&
      activeProfile?.hasOperatorCredential &&
      activeProfile.endpoint &&
      activeProfile.endpoint.tlsTrust !== "configured_ca"
  );
  const canRegisterWithAdmin = Boolean(
    hasDirectRegistration && selected.length > 0 && !busy && !loading
  );
  const canEnrollFromClipboard = Boolean(
    status?.supported &&
      status.state === "not_registered" &&
      selected.length > 0 &&
      !busy &&
      !loading
  );
  const canUpdate = status?.state !== "not_registered" && hasDirectRegistration;
  const canRegisterDirectly = status?.state === "not_registered" && hasDirectRegistration;

  return (
    <Card data-testid="host-admin-local-agent-host">
      <CardHeader>
        <div className="flex size-9 items-center justify-center rounded-lg bg-state-selected-surface text-text-strong">
          <LaptopIcon className="size-4" aria-hidden="true" />
        </div>
        <CardTitle>{t("hostAdminLocalHostTitle")}</CardTitle>
        <CardDescription>{t("hostAdminLocalHostDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {loading ? <p className="text-sm text-text-muted">{t("hostAdminLoading")}</p> : null}
        {status && !status.supported ? (
          <p className="text-sm text-text-muted" data-testid="host-admin-local-unsupported">
            {t("hostAdminLocalHostWindowsOnly")}
          </p>
        ) : null}
        {status?.supported ? (
          <>
            {activeProfile?.endpoint?.tlsTrust === "configured_ca" ? (
              <p className="text-sm text-text-muted" data-testid="host-admin-local-custom-ca">
                {t("hostAdminLocalHostCustomCaUnsupported")}
              </p>
            ) : null}
            <p className="text-xs text-text-muted" data-testid="host-admin-local-status">
              {status.state === "ready"
                ? t("hostAdminLocalHostReady")
                : status.state === "background_setup_required"
                  ? t("hostAdminLocalHostSetupRequired")
                  : t("hostAdminLocalHostNotRegistered")}
            </p>
            <div className="grid gap-2">
              {status.agents.map((agent) => (
                <label
                  className="flex items-center justify-between gap-3 text-sm"
                  key={agent.profileId}
                >
                  <span>
                    {agent.displayName}
                    {agent.detected ? ` · ${t("hostAdminLocalHostDetected")}` : ""}
                  </span>
                  <input
                    type="checkbox"
                    data-testid={`host-admin-local-agent-${agent.profileId}`}
                    checked={selected.includes(agent.profileId)}
                    disabled={busy || loading}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...new Set([...current, agent.profileId])]
                          : current.filter((profileId) => profileId !== agent.profileId)
                      )
                    }
                  />
                </label>
              ))}
            </div>
            <p className="text-xs text-text-muted">{t("hostAdminLocalHostCredentialBoundary")}</p>
            {status.state === "not_registered" && !canRegisterDirectly ? (
              <div className="grid gap-2">
                <p className="text-xs text-text-muted">{t("hostAdminLocalHostClipboardHandoff")}</p>
                <Button
                  type="button"
                  className="w-fit"
                  data-testid="host-admin-enroll-local-clipboard"
                  disabled={!canEnrollFromClipboard}
                  onClick={() => void enrollFromClipboard(selected)}
                >
                  {t("hostAdminEnrollThisComputerFromClipboard")}
                </Button>
              </div>
            ) : null}
            {canRegisterDirectly || canUpdate ? (
              <Button
                type="button"
                className="w-fit"
                variant="outline"
                data-testid="host-admin-register-local"
                disabled={!canRegisterWithAdmin}
                onClick={() => void register(selected)}
              >
                {status.state === "not_registered"
                  ? t("hostAdminRegisterThisComputer")
                  : t("hostAdminUpdateThisComputer")}
              </Button>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
