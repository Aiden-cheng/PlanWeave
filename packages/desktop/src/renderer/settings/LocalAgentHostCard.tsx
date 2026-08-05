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
  localServerHosted: boolean;
  loading: boolean;
  status: OperatorLocalAgentHostStatus | null;
  register: (profileIds: readonly string[]) => Promise<OperatorLocalAgentHostStatus | null>;
  repair: () => Promise<OperatorLocalAgentHostStatus | null>;
  enroll: (
    handoff: string,
    profileIds: readonly string[]
  ) => Promise<OperatorLocalAgentHostStatus | null>;
  t: ReturnType<typeof createTranslator>;
};

export function LocalAgentHostCard({
  activeProfile,
  busy,
  localServerHosted,
  loading,
  status,
  register,
  repair,
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
    !localServerHosted && hasDirectRegistration && selected.length > 0 && !busy && !loading
  );
  const canEnroll = Boolean(
    !localServerHosted &&
      status?.supported &&
      status.state === "not_registered" &&
      handoff.trim().length > 0 &&
      selected.length > 0 &&
      !busy &&
      !loading
  );
  const canUpdate =
    !localServerHosted && status?.state !== "not_registered" && hasDirectRegistration;
  const canRegisterDirectly =
    !localServerHosted && status?.state === "not_registered" && hasDirectRegistration;

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
              {localServerHosted
                ? t("hostAdminLocalHostUsesLocalServer")
                : status.state === "ready"
                  ? t("hostAdminLocalHostReady")
                  : status.state === "background_setup_required"
                    ? t("hostAdminLocalHostSetupRequired")
                    : t("hostAdminLocalHostNotRegistered")}
            </p>
            {!localServerHosted && status.state === "not_registered" ? (
              <div className="grid gap-2">
                <p className="text-xs leading-5 text-text-muted">
                  {t("hostAdminLocalHostHandoffPrompt")}
                </p>
                <label
                  className="grid gap-1.5 text-sm font-medium text-text-strong"
                  htmlFor="host-admin-local-handoff"
                >
                  {t("hostAdminLocalHostHandoffLabel")}
                  <Textarea
                    id="host-admin-local-handoff"
                    data-testid="host-admin-local-handoff"
                    className="cursor-text caret-text-strong"
                    value={handoff}
                    rows={4}
                    spellCheck={false}
                    autoComplete="off"
                    autoFocus
                    placeholder={t("hostAdminLocalHostHandoffPlaceholder")}
                    disabled={busy || loading}
                    onChange={(event) => setHandoff(event.target.value)}
                  />
                </label>
              </div>
            ) : null}
            {!localServerHosted ? (
              <p className="text-sm font-medium text-text-strong">
                {t("hostAdminLocalHostAgentSelectionLabel")}
              </p>
            ) : null}
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
                    disabled={localServerHosted || busy || loading}
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
            {!localServerHosted ? (
              <p className="text-xs text-text-muted">{t("hostAdminLocalHostCredentialBoundary")}</p>
            ) : null}
            {!localServerHosted && status.state !== "not_registered" ? (
              <Button
                type="button"
                className="w-fit"
                data-testid="host-admin-repair-local"
                disabled={busy || loading}
                onClick={() => void repair()}
              >
                {status.state === "ready"
                  ? t("hostAdminRestartLocalHost")
                  : t("hostAdminStartLocalHost")}
              </Button>
            ) : null}
            {!localServerHosted && status.state === "not_registered" ? (
              <div className="grid gap-3">
                <Button
                  type="button"
                  className="w-fit"
                  data-testid="host-admin-enroll-local"
                  disabled={!canEnroll}
                  onClick={() => {
                    void enroll(handoff, selected).then((next) => {
                      if (next) setHandoff("");
                    });
                  }}
                >
                  {t("hostAdminEnrollThisComputer")}
                </Button>
                {canRegisterDirectly ? (
                  <p className="text-xs leading-5 text-text-muted">
                    {t("hostAdminLocalHostDirectRegistrationAlternative")}
                  </p>
                ) : null}
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
                  ? t("hostAdminRegisterWithCurrentProfile")
                  : t("hostAdminUpdateThisComputer")}
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
