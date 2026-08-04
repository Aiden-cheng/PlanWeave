import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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
  enroll: (
    handoff: string,
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
  enroll,
  t
}: LocalAgentHostCardProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [handoff, setHandoff] = useState("");

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
  const canEnroll = Boolean(
    status?.supported &&
      status.state === "not_registered" &&
      handoff.trim().length > 0 &&
      selected.length > 0 &&
      !busy &&
      !loading
  );
  const canUpdate = status?.state !== "not_registered" && hasDirectRegistration;
  const canRegisterDirectly = status?.state === "not_registered" && hasDirectRegistration;

  return (
    <section className="border-t border-border/70 py-8" data-testid="host-admin-local-agent-host">
      <div className="max-w-3xl">
        <h2 className="text-lg font-semibold tracking-[-0.01em] text-text-strong">
          {t("hostAdminLocalHostTitle")}
        </h2>
        <p className="mt-1 text-sm leading-6 text-text-muted">
          {t("hostAdminLocalHostDescription")}
        </p>
      </div>
      <div className="mt-5 grid max-w-3xl gap-4">
        {loading ? <p className="text-sm text-text-muted">{t("hostAdminLoading")}</p> : null}
        {status && !status.supported ? (
          <p className="text-sm text-text-muted" data-testid="host-admin-local-unsupported">
            {t("hostAdminLocalHostUnsupported")}
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
            <div className="divide-y divide-border/60 border-y border-border/60">
              {status.agents.map((agent) => (
                <label
                  className="flex items-center justify-between gap-3 py-3 text-sm"
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
                <p className="text-xs text-text-muted">{t("hostAdminLocalHostHandoffPrompt")}</p>
                <label
                  className="grid gap-1.5 text-sm text-text-strong"
                  htmlFor="host-admin-local-handoff"
                >
                  {t("hostAdminLocalHostHandoffLabel")}
                  <Textarea
                    id="host-admin-local-handoff"
                    data-testid="host-admin-local-handoff"
                    value={handoff}
                    rows={3}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={t("hostAdminLocalHostHandoffPlaceholder")}
                    disabled={busy || loading}
                    onChange={(event) => setHandoff(event.target.value)}
                  />
                </label>
                <Button
                  type="button"
                  className="w-fit"
                  data-testid="host-admin-enroll-local"
                  disabled={!canEnroll}
                  onClick={() =>
                    void enroll(handoff, selected).then((next) => {
                      if (next) setHandoff("");
                    })
                  }
                >
                  {t("hostAdminEnrollThisComputer")}
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
      </div>
    </section>
  );
}
