import type { OperatorHostView } from "@planweave-ai/agent-host-protocol";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { createTranslator } from "../i18n";
import { useHostAdministrationController } from "../hooks/useHostAdministrationController";
import { HostBootstrapCard } from "./HostBootstrapCard";
import { LocalAgentHostCard } from "./LocalAgentHostCard";
import { HostAvailabilityCard } from "./HostAvailabilityCard";
import { DeploymentConnectionCard } from "./DeploymentConnectionCard";

type HostAdministrationSectionProps = {
  t: ReturnType<typeof createTranslator>;
};

function errorLabel(code: string | null, t: ReturnType<typeof createTranslator>): string | null {
  if (!code) return null;
  if (code === "local_agent_host_unavailable") {
    return t("hostAdminLocalHostUnsupported");
  }
  if (code === "local_agent_host_custom_ca_unsupported") {
    return t("hostAdminLocalHostCustomCaUnsupported");
  }
  if (code === "local_agent_host_handoff_invalid") {
    return t("hostAdminLocalHostHandoffInvalid");
  }
  if (code === "local_agent_host_handoff_expired") {
    return t("hostAdminLocalHostHandoffExpired");
  }
  if (code === "agent_host_preset_binary_missing") {
    return t("hostAdminLocalHostAgentMissing");
  }
  if (code === "agent_host_background_setup_required") {
    return t("hostAdminLocalHostSetupRequired");
  }
  const key =
    code === "operator_bridge_unavailable"
      ? "hostAdminBridgeUnavailable"
      : code === "operator_credential_missing"
        ? "hostAdminCredentialMissing"
        : code === "operator_profile_missing" || code === "operator_profile_not_found"
          ? "hostAdminProfileMissing"
          : code === "operator_offline" || code === "operator_timeout"
            ? "hostAdminOffline"
            : code === "operator_unauthorized" || code === "operator_credential_invalid"
              ? "hostAdminUnauthorized"
              : code === "operator_admin_required" ||
                  code === "operator_server_admin_required" ||
                  code === "operator_forbidden"
                ? "hostAdminForbidden"
                : "hostAdminErrorGeneric";
  return t(key);
}

export function HostAdministrationSection({ t }: HostAdministrationSectionProps) {
  const controller = useHostAdministrationController();
  const {
    activeProfile,
    busy,
    copyBootstrapHandoff,
    dismissHandoff,
    enrollLocalAgentHost,
    error,
    handoff,
    hosts,
    hostsLoading,
    loadState,
    localAgentHost,
    localAgentHostLoading,
    refresh,
    refreshHosts,
    registerLocalAgentHost
  } = controller;

  const handleRevoke = async (host: OperatorHostView) => {
    if (host.revokedAt || busy) return;
    if (!window.confirm(`${t("hostAdminRevokeConfirm")}\n\n${host.displayName}`)) return;
    await controller.revokeHost(host.id);
  };

  const currentError = errorLabel(error, t);

  return (
    <div className="flex flex-col" data-testid="host-administration">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-text-strong">
            {t("hostAdminTitle")}
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-text-muted">
            {t("hostAdminDescription")}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="host-admin-refresh"
          disabled={busy || loadState === "loading"}
          onClick={() => void refresh().then(refreshHosts)}
        >
          <RefreshCwIcon data-icon="inline-start" />
          {t("hostAdminRefresh")}
        </Button>
      </header>

      {loadState === "unavailable" ? (
        <div
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          role="alert"
          data-testid="host-admin-unavailable"
        >
          {t("hostAdminBridgeUnavailable")}
        </div>
      ) : null}
      {currentError ? (
        <div
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          role="alert"
          data-testid="host-admin-error"
        >
          {currentError}
        </div>
      ) : null}

      <DeploymentConnectionCard presentation="section" t={t} />

      <LocalAgentHostCard
        activeProfile={activeProfile}
        busy={busy}
        loading={localAgentHostLoading}
        status={localAgentHost}
        register={registerLocalAgentHost}
        enroll={enrollLocalAgentHost}
        t={t}
      />

      <HostBootstrapCard
        activeProfile={activeProfile}
        busy={busy}
        copyBootstrapHandoff={copyBootstrapHandoff}
        dismissHandoff={dismissHandoff}
        handoff={handoff}
        handoffState={busy ? "pending" : handoff ? "ready" : error ? "failed" : "idle"}
        onRetry={copyBootstrapHandoff}
        t={t}
      />

      <HostAvailabilityCard
        busy={busy}
        hosts={hosts}
        loading={hostsLoading}
        onRefresh={() => void refreshHosts()}
        onRevoke={(host) => void handleRevoke(host)}
        t={t}
      />
    </div>
  );
}
