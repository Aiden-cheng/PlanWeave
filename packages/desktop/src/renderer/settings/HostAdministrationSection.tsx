import { useEffect, useState, type FormEvent } from "react";
import type { OperatorHostView } from "@planweave-ai/agent-host-protocol";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { createTranslator } from "../i18n";
import { useHostAdministrationController } from "../hooks/useHostAdministrationController";
import { HostBootstrapCard } from "./HostBootstrapCard";
import { LocalAgentHostCard } from "./LocalAgentHostCard";
import { HostAvailabilityCard } from "./HostAvailabilityCard";
import { DeploymentConnectionCard } from "./DeploymentConnectionCard";
import { MemberSetupCodeCard } from "./MemberSetupCodeCard";

type HostAdministrationSectionProps = {
  t: ReturnType<typeof createTranslator>;
};

type HostHeartbeatState = "revoked" | "offline" | "online";

function heartbeatState(host: OperatorHostView): HostHeartbeatState {
  if (host.revokedAt) return "revoked";
  return host.online ? "online" : "offline";
}

function formatDate(value: string | undefined, locale: string, fallback: string): string {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? fallback : date.toLocaleString(locale);
}

function errorLabel(code: string | null, t: ReturnType<typeof createTranslator>): string | null {
  if (!code) return null;
  if (code === "local_agent_host_windows_only" || code === "local_agent_host_unavailable") {
    return t("hostAdminLocalHostWindowsOnly");
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

function serverUrlWithSlash(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export function HostAdministrationSection({ t }: HostAdministrationSectionProps) {
  const controller = useHostAdministrationController();
  const {
    activeProfile,
    busy,
    clearActiveProfile,
    clearCredential,
    copyBootstrapHandoff,
    copyMemberSetupCode,
    dismissHandoff,
    dismissMemberSetupCodeHandoff,
    error,
    handoff,
    memberSetupCodeHandoff,
    localAgentHost,
    localAgentHostLoading,
    enrollLocalAgentHostFromClipboard,
    hosts,
    hostsLoading,
    importCredential,
    loadState,
    refresh,
    refreshHosts,
    removeProfile,
    registerLocalAgentHost,
    saveProfile,
    selectProfile,
    status
  } = controller;
  const locale = t("hostAdminLocale");
  const [profileId, setProfileId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [serverBaseUrl, setServerBaseUrl] = useState("");
  const [allowInsecureTransport, setAllowInsecureTransport] = useState(false);
  const [operatorId, setOperatorId] = useState("");

  useEffect(() => {
    if (!activeProfile) return;
    setProfileId(activeProfile.profileId);
    setDisplayName(activeProfile.displayName);
    setServerBaseUrl(activeProfile.serverBaseUrl);
    setAllowInsecureTransport(activeProfile.allowInsecureTransport);
  }, [activeProfile]);

  const handleSaveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!profileId.trim() || !displayName.trim() || !serverBaseUrl.trim()) return;
    const saved = await saveProfile({
      profileId: profileId.trim(),
      displayName: displayName.trim(),
      serverBaseUrl: serverUrlWithSlash(serverBaseUrl),
      allowInsecureTransport
    });
    if (saved) await selectProfile(profileId.trim());
  };

  const handleImportCredential = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeProfile) return;
    const imported = await importCredential(activeProfile.profileId, operatorId);
    if (imported) {
      setOperatorId("");
    }
  };

  const handleRevoke = async (host: OperatorHostView) => {
    if (host.revokedAt || busy) return;
    if (!window.confirm(`${t("hostAdminRevokeConfirm")}\n\n${host.displayName}`)) return;
    await controller.revokeHost(host.id);
  };

  const currentError = errorLabel(error, t);

  return (
    <div className="flex flex-col gap-6" data-testid="host-administration">
      <header>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-text-strong">{t("hostAdminTitle")}</h1>
            <p className="mt-1 max-w-2xl text-sm text-text-muted">{t("hostAdminDescription")}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            data-testid="host-admin-refresh"
            disabled={busy || loadState === "loading"}
            onClick={() => void refresh().then(refreshHosts)}
          >
            {t("hostAdminRefresh")}
          </Button>
        </div>
        <p
          className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-text-muted"
          role="note"
        >
          {t("hostAdminDesktopBoundary")}
        </p>
      </header>

      {loadState === "unavailable" ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
          data-testid="host-admin-unavailable"
        >
          {t("hostAdminBridgeUnavailable")}
        </div>
      ) : null}
      {currentError ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
          data-testid="host-admin-error"
        >
          {currentError}
        </div>
      ) : null}
      {status?.nonPersistenceWarning ? (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
          role="status"
          data-testid="host-admin-session-warning"
        >
          {t("hostAdminSessionOnlyWarning")}
        </div>
      ) : null}

      <DeploymentConnectionCard t={t} />

      <MemberSetupCodeCard
        t={t}
        enabled={Boolean(activeProfile?.hasOperatorCredential)}
        busy={busy}
        handoff={memberSetupCodeHandoff}
        onCopy={() => void copyMemberSetupCode()}
        onDismiss={dismissMemberSetupCodeHandoff}
      />

      <HostAvailabilityCard
        hosts={hosts}
        loading={hostsLoading}
        onRefresh={() => void refreshHosts()}
        t={t}
      />

      <LocalAgentHostCard
        activeProfile={activeProfile}
        busy={busy}
        loading={localAgentHostLoading}
        status={localAgentHost}
        register={registerLocalAgentHost}
        enrollFromClipboard={enrollLocalAgentHostFromClipboard}
        t={t}
      />

      <Card data-testid="host-admin-profiles">
        <CardHeader>
          <CardTitle>{t("hostAdminProfileTitle")}</CardTitle>
          <CardDescription>{t("hostAdminProfileDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <ul className="flex flex-col gap-2" aria-label={t("hostAdminProfilesLabel")}>
            {status?.profiles.length ? (
              status.profiles.map((profile) => (
                <li
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/80 bg-surface-muted/30 px-3 py-2"
                  data-testid={`host-admin-profile-${profile.profileId}`}
                  key={profile.profileId}
                >
                  <div className="min-w-0">
                    <div className="font-medium text-text-strong">{profile.displayName}</div>
                    <div className="truncate text-xs text-text-muted">{profile.serverBaseUrl}</div>
                    <div className="text-xs text-text-muted">
                      {profile.hasOperatorCredential
                        ? `${t("hostAdminCredentialAvailable")} · ${t(`hostAdminCredentialPersistence_${profile.operatorCredentialPersistence}`)}`
                        : t("hostAdminCredentialMissing")}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant={
                        activeProfile?.profileId === profile.profileId ? "secondary" : "outline"
                      }
                      data-testid={`host-admin-select-${profile.profileId}`}
                      disabled={busy || Boolean(handoff)}
                      onClick={() => void selectProfile(profile.profileId)}
                    >
                      {activeProfile?.profileId === profile.profileId
                        ? t("hostAdminSelected")
                        : t("hostAdminSelect")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      data-testid={`host-admin-remove-${profile.profileId}`}
                      disabled={busy || Boolean(handoff)}
                      onClick={() => {
                        if (window.confirm(t("hostAdminRemoveProfileConfirm"))) {
                          void removeProfile(profile.profileId);
                        }
                      }}
                    >
                      {t("hostAdminRemoveProfile")}
                    </Button>
                  </div>
                </li>
              ))
            ) : (
              <li className="text-sm text-text-muted" data-testid="host-admin-no-profiles">
                {t("hostAdminNoProfiles")}
              </li>
            )}
          </ul>

          <form
            className="grid gap-3 border-t border-border/70 pt-4"
            onSubmit={(event) => void handleSaveProfile(event)}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="host-admin-profile-id">{t("hostAdminProfileId")}</Label>
                <Input
                  id="host-admin-profile-id"
                  data-testid="host-admin-profile-id"
                  value={profileId}
                  onChange={(event) => setProfileId(event.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="host-admin-display-name">{t("hostAdminDisplayName")}</Label>
                <Input
                  id="host-admin-display-name"
                  data-testid="host-admin-display-name"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="host-admin-server-url">{t("hostAdminServerUrl")}</Label>
              <Input
                id="host-admin-server-url"
                data-testid="host-admin-server-url"
                type="url"
                value={serverBaseUrl}
                onChange={(event) => setServerBaseUrl(event.target.value)}
                placeholder="https://server.example/"
                autoComplete="url"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-text-muted">
              <input
                type="checkbox"
                data-testid="host-admin-allow-insecure"
                checked={allowInsecureTransport}
                onChange={(event) => setAllowInsecureTransport(event.target.checked)}
              />
              {t("hostAdminAllowInsecure")}
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                data-testid="host-admin-save-profile"
                disabled={
                  busy ||
                  Boolean(handoff) ||
                  !profileId.trim() ||
                  !displayName.trim() ||
                  !serverBaseUrl.trim()
                }
              >
                {t("hostAdminSaveProfile")}
              </Button>
              {activeProfile ? (
                <Button
                  type="button"
                  variant="ghost"
                  data-testid="host-admin-clear-active"
                  disabled={busy || Boolean(handoff)}
                  onClick={() => void clearActiveProfile()}
                >
                  {t("hostAdminClearActive")}
                </Button>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>

      <Card data-testid="host-admin-credential">
        <CardHeader>
          <CardTitle>{t("hostAdminCredentialTitle")}</CardTitle>
          <CardDescription>{t("hostAdminCredentialDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {!activeProfile ? (
            <p className="text-sm text-text-muted" data-testid="host-admin-credential-no-profile">
              {t("hostAdminNoActiveProfile")}
            </p>
          ) : (
            <form className="grid gap-3" onSubmit={(event) => void handleImportCredential(event)}>
              <p className="text-xs text-text-muted">
                {activeProfile.hasOperatorCredential
                  ? t("hostAdminCredentialAvailable")
                  : t("hostAdminCredentialMissing")}
              </p>
              <div className="grid gap-1.5">
                <div className="grid gap-1.5">
                  <Label htmlFor="host-admin-operator-id">{t("hostAdminOperatorId")}</Label>
                  <Input
                    id="host-admin-operator-id"
                    data-testid="host-admin-operator-id"
                    value={operatorId}
                    onChange={(event) => setOperatorId(event.target.value)}
                    autoComplete="off"
                  />
                </div>
              </div>
              <p className="text-xs text-text-muted">{t("hostAdminOperatorCredential")}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  data-testid="host-admin-import-credential"
                  disabled={busy || Boolean(handoff)}
                >
                  {t("hostAdminImportCredential")}
                </Button>
                {activeProfile.hasOperatorCredential ? (
                  <Button
                    type="button"
                    variant="ghost"
                    data-testid="host-admin-clear-credential"
                    disabled={busy || Boolean(handoff)}
                    onClick={() => void clearCredential(activeProfile.profileId)}
                  >
                    {t("hostAdminClearCredential")}
                  </Button>
                ) : null}
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      <Card data-testid="host-admin-inventory">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle>{t("hostAdminInventoryTitle")}</CardTitle>
              <CardDescription>{t("hostAdminInventoryDescription")}</CardDescription>
              <p className="mt-1 text-xs text-text-muted">{t("hostAdminStatusAuthorityGap")}</p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="host-admin-refresh-hosts"
              disabled={busy || hostsLoading || !activeProfile?.hasOperatorCredential}
              onClick={() => void refreshHosts()}
            >
              {t("hostAdminRefresh")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3">
          {!activeProfile ? (
            <p className="text-sm text-text-muted" data-testid="host-admin-inventory-no-profile">
              {t("hostAdminNoActiveProfile")}
            </p>
          ) : null}
          {activeProfile && !activeProfile.hasOperatorCredential ? (
            <p className="text-sm text-text-muted" data-testid="host-admin-inventory-no-credential">
              {t("hostAdminCredentialMissing")}
            </p>
          ) : null}
          {activeProfile?.hasOperatorCredential && hostsLoading ? (
            <p
              className="text-sm text-text-muted"
              role="status"
              data-testid="host-admin-inventory-loading"
            >
              {t("hostAdminLoading")}
            </p>
          ) : null}
          {activeProfile?.hasOperatorCredential && !hostsLoading && hosts.length === 0 ? (
            <p className="text-sm text-text-muted" data-testid="host-admin-inventory-empty">
              {t("hostAdminNoHosts")}
            </p>
          ) : null}
          {hosts.map((host) => {
            const state = heartbeatState(host);
            return (
              <article
                className="rounded-md border border-border/80 p-3"
                data-testid={`host-admin-host-${host.id}`}
                key={host.id}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="font-medium text-text-strong">{host.displayName}</h3>
                    <p className="font-mono text-xs text-text-muted">{host.id}</p>
                  </div>
                  <span
                    className="rounded px-2 py-0.5 text-xs font-medium"
                    data-testid={`host-admin-host-status-${host.id}`}
                    data-status={state}
                  >
                    {state === "revoked"
                      ? t("hostAdminStatusRevoked")
                      : state === "online"
                        ? t("hostAdminStatusOnline")
                        : t("hostAdminStatusOffline")}
                  </span>
                </div>
                <dl className="mt-3 grid gap-2 text-xs text-text-muted sm:grid-cols-2">
                  <div>
                    <dt className="font-medium text-text-strong">{t("hostAdminCapacity")}</dt>
                    <dd>{host.capacity}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-text-strong">{t("hostAdminCapabilities")}</dt>
                    <dd>
                      {host.capabilities.length
                        ? host.capabilities.join(", ")
                        : t("hostAdminCapabilitiesNone")}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-medium text-text-strong">{t("hostAdminLastHeartbeat")}</dt>
                    <dd>{formatDate(host.lastSeenAt, locale, t("hostAdminNotReported"))}</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-text-strong">
                      {t("hostAdminCredentialExpiry")}
                    </dt>
                    <dd>
                      {formatDate(host.credentialExpiresAt, locale, t("hostAdminNotReported"))}
                    </dd>
                  </div>
                  {host.revokedAt ? (
                    <div>
                      <dt className="font-medium text-text-strong">{t("hostAdminRevokedAt")}</dt>
                      <dd>{formatDate(host.revokedAt, locale, t("hostAdminNotReported"))}</dd>
                    </div>
                  ) : null}
                </dl>
                <div className="mt-3">
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    data-testid={`host-admin-revoke-${host.id}`}
                    disabled={busy || state === "revoked"}
                    onClick={() => void handleRevoke(host)}
                  >
                    {t("hostAdminRevoke")}
                  </Button>
                </div>
              </article>
            );
          })}
        </CardContent>
      </Card>

      <HostBootstrapCard
        activeProfile={activeProfile}
        busy={busy}
        copyBootstrapHandoff={copyBootstrapHandoff}
        dismissHandoff={dismissHandoff}
        handoff={handoff}
        handoffState={busy ? "pending" : handoff ? "ready" : error ? "failed" : "idle"}
        handoffError={error}
        onRetry={copyBootstrapHandoff}
        t={t}
      />
    </div>
  );
}
