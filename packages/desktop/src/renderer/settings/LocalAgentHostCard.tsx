import { useEffect, useState } from "react";
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
  t: ReturnType<typeof createTranslator>;
};

export function LocalAgentHostCard({
  activeProfile,
  busy,
  loading,
  status,
  register,
  t
}: LocalAgentHostCardProps) {
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    setSelected(status?.agents.filter((agent) => agent.exposed).map((agent) => agent.profileId) ?? []);
  }, [status]);

  const enabled = Boolean(
    status?.supported &&
      activeProfile?.hasOperatorCredential &&
      activeProfile.endpoint &&
      activeProfile.endpoint.tlsTrust !== "configured_ca" &&
      selected.length > 0 &&
      !busy &&
      !loading
  );

  return (
    <Card data-testid="host-admin-local-agent-host">
      <CardHeader>
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
                <label className="flex items-center justify-between gap-3 text-sm" key={agent.profileId}>
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
            <Button
              type="button"
              className="w-fit"
              data-testid="host-admin-register-local"
              disabled={!enabled}
              onClick={() => void register(selected)}
            >
              {status.state === "not_registered"
                ? t("hostAdminRegisterThisComputer")
                : t("hostAdminUpdateThisComputer")}
            </Button>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
