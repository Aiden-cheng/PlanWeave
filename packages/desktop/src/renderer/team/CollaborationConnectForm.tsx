import { useId, useRef, useState } from "react";
import { ServerIcon } from "lucide-react";
import type {
  ActiveWorkspaceConnectionView,
  WorkspacePickerItem
} from "@planweave-ai/collaboration-contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { createTranslator } from "../i18n";
import {
  collaborationRedeemSetupCodeInputSchema,
  type CollaborationStatus,
  type PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";
import { collaborationErrorMessage } from "../collaboration/formatCollaborationError";

export type CollaborationConnectFormProps = {
  api: PlanWeaveCollaborationApi | null;
  status: CollaborationStatus | null;
  t: ReturnType<typeof createTranslator>;
  onConnected?: () => void;
  /** Restore focus to the people trigger after successful close actions. */
  onRequestClose?: () => void;
};

type ConnectMode = "setup" | "join" | "bootstrap" | "connect";

function newProfileId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `profile-${crypto.randomUUID()}`;
  }
  return `profile-${Date.now()}`;
}

function workspaceStatusLabel(
  connection: ActiveWorkspaceConnectionView | null | undefined,
  t: ReturnType<typeof createTranslator>
): string {
  if (!connection) return t("peopleWorkspaceLocalOnly");
  switch (connection.status) {
    case "local_only":
      return t("peopleWorkspaceLocalOnly");
    case "connecting":
      return t("peopleWorkspaceConnecting");
    case "connected":
      return t("peopleWorkspaceConnected");
    case "reconnecting":
      return t("peopleWorkspaceReconnecting");
    case "error":
      return t("peopleWorkspaceError");
    case "disconnected":
      return t("peopleWorkspaceDisconnected");
    default:
      return connection.status;
  }
}

/**
 * Join / bootstrap / setup-code / connect onboarding.
 * Setup codes and device tokens are never retained in renderer state.
 */
export function CollaborationConnectForm({
  api,
  status,
  t,
  onConnected,
  onRequestClose
}: CollaborationConnectFormProps) {
  const formId = useId();
  const [mode, setMode] = useState<ConnectMode>("setup");
  const [displayName, setDisplayName] = useState("");
  const [serverBaseUrl, setServerBaseUrl] = useState("https://");
  const [projectId, setProjectId] = useState("");
  const [invitationToken, setInvitationToken] = useState("");
  const setupCodeInputRef = useRef<HTMLInputElement>(null);
  const [allowInsecureTransport, setAllowInsecureTransport] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const profiles = status?.profiles ?? [];
  const activeProfile =
    profiles.find((profile) => profile.profileId === status?.activeProfileId) ??
    profiles[0] ??
    null;
  const workspaceConnection = status?.workspaceConnection ?? null;
  const workspacePickerItems: WorkspacePickerItem[] = status?.workspacePicker?.items ?? [];
  const submitLabel =
    mode === "setup"
      ? t("peopleConnectSetupSubmit")
      : mode === "join"
        ? t("peopleConnectJoinSubmit")
        : mode === "bootstrap"
          ? t("peopleConnectBootstrapSubmit")
          : t("peopleConnectExistingSubmit");

  const submit = async () => {
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (mode === "setup") {
        const setupCodeInput = setupCodeInputRef.current;
        if (!setupCodeInput) {
          throw new Error("Setup code input is unavailable.");
        }
        const code = setupCodeInput.value.trim();
        // Keep the one-time code out of React state and clear the element before IPC.
        setupCodeInput.value = "";
        const candidate = {
          serverBaseUrl: serverBaseUrl.trim(),
          allowInsecureTransport,
          setupCode: code,
          displayName: displayName.trim() || t("peopleDefaultProfileName")
        };
        const parsed = collaborationRedeemSetupCodeInputSchema.safeParse(candidate);
        if (!parsed.success) {
          const invalidFields = new Set(parsed.error.issues.map((issue) => issue.path[0]));
          const invalidServer = invalidFields.has("serverBaseUrl");
          const invalidCode = invalidFields.has("setupCode");
          setError(
            invalidServer && invalidCode
              ? t("peopleSetupCodeFieldsInvalid")
              : invalidServer
                ? t("peopleServerUrlInvalid")
                : t("peopleSetupCodeInvalid")
          );
          return;
        }
        await api.redeemCollaborationSetupCode(parsed.data);
        onConnected?.();
        return;
      }

      if (mode === "connect") {
        if (
          workspaceConnection?.status === "disconnected" ||
          workspaceConnection?.status === "error"
        ) {
          await api.connectWorkspaceConnection();
          onConnected?.();
          return;
        }
        if (!activeProfile) {
          throw new Error(t("peopleNoProfileToConnect"));
        }
        if (!activeProfile.hasDeviceCredential) {
          throw new Error(t("peopleMissingCredential"));
        }
        await api.setActiveCollaborationProfile({ profileId: activeProfile.profileId });
        await api.connectCollaborationSession({ profileId: activeProfile.profileId });
        onConnected?.();
        return;
      }

      const profileId = activeProfile?.profileId ?? newProfileId();
      const profileDisplayName =
        displayName.trim() || activeProfile?.displayName || t("peopleDefaultProfileName");
      await api.upsertCollaborationProfile({
        profileId,
        displayName: profileDisplayName,
        serverBaseUrl: serverBaseUrl.trim() || activeProfile?.serverBaseUrl || "",
        projectId: projectId.trim() || activeProfile?.projectId || "",
        allowInsecureTransport
      });

      if (mode === "bootstrap") {
        const handoff = await api.bootstrapCollaborationOwner({
          profileId,
          request: { displayName: profileDisplayName }
        });
        if (
          handoff.nonPersistenceWarning ||
          handoff.deviceCredentialPersistence === "session-only"
        ) {
          setInfo(t("peopleSessionOnlyCredentialWarning"));
        }
      } else {
        const handoff = await api.consumeCollaborationInvitation({
          profileId,
          request: {
            invitationToken: invitationToken.trim(),
            displayName: profileDisplayName
          }
        });
        if (
          handoff.nonPersistenceWarning ||
          handoff.deviceCredentialPersistence === "session-only"
        ) {
          setInfo(t("peopleSessionOnlyCredentialWarning"));
        }
      }

      await api.connectCollaborationSession({ profileId });
      setInvitationToken("");
      onConnected?.();
    } catch (submitError) {
      setError(collaborationErrorMessage(submitError));
    } finally {
      setBusy(false);
    }
  };

  const selectWorkspace = async (workspaceId: string) => {
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.selectWorkspaceConnection({ workspaceId });
      onConnected?.();
    } catch (selectError) {
      setError(collaborationErrorMessage(selectError));
    } finally {
      setBusy(false);
    }
  };

  const disconnectWorkspace = async () => {
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.disconnectWorkspaceConnection();
    } catch (disconnectError) {
      setError(collaborationErrorMessage(disconnectError));
    } finally {
      setBusy(false);
    }
  };

  const retryWorkspace = async () => {
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.retryWorkspaceConnection();
      onConnected?.();
    } catch (retryError) {
      setError(collaborationErrorMessage(retryError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="overflow-hidden rounded-xl border border-border/70 bg-background shadow-sm"
      data-testid="people-connect-form"
      aria-labelledby="people-remote-workspace-title"
    >
      <div className="flex items-start gap-3 border-b border-border/60 p-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-700 dark:text-sky-300">
          <ServerIcon className="size-4" aria-hidden="true" />
        </div>
        <div>
          <h2 id="people-remote-workspace-title" className="text-sm font-semibold text-text-strong">
            {t("peopleRemoteWorkspaceTitle")}
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
            {t("peopleRemoteWorkspaceDescription")}
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-3 p-4">
        <div
          className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5 text-xs"
          data-testid="people-workspace-connection-status"
          data-status={workspaceConnection?.status ?? "local_only"}
          role="status"
        >
          <div className="font-medium text-text-strong">
            {workspaceStatusLabel(workspaceConnection, t)}
          </div>
          {workspaceConnection?.workspaceDisplayName ? (
            <div className="text-muted-foreground">{workspaceConnection.workspaceDisplayName}</div>
          ) : (
            <div className="text-muted-foreground">{t("peopleWorkspaceLocalOnlyHint")}</div>
          )}
          {workspaceConnection?.profile?.serverBaseUrl ? (
            <div className="text-muted-foreground">{workspaceConnection.profile.serverBaseUrl}</div>
          ) : null}
          {workspaceConnection?.status === "error" && workspaceConnection.error ? (
            <div className="mt-1 text-destructive" data-testid="people-workspace-connection-error">
              {workspaceConnection.error.message ?? workspaceConnection.error.code}
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-1">
            {workspaceConnection?.status === "error" && workspaceConnection.error?.retryable ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="people-workspace-retry"
                disabled={busy || !api}
                onClick={() => void retryWorkspace()}
              >
                {t("peopleWorkspaceRetry")}
              </Button>
            ) : null}
            {workspaceConnection && workspaceConnection.status !== "local_only" ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                data-testid="people-workspace-disconnect"
                disabled={busy || !api}
                onClick={() => void disconnectWorkspace()}
              >
                {t("peopleWorkspaceStayLocal")}
              </Button>
            ) : null}
          </div>
        </div>

        {workspacePickerItems.length > 0 ? (
          <div
            className="flex flex-col gap-1"
            data-testid="people-workspace-picker"
            role="listbox"
            aria-label={t("peopleWorkspacePicker")}
          >
            <div className="text-xs font-medium text-text-strong">{t("peopleWorkspacePicker")}</div>
            {workspacePickerItems.map((item) => (
              <button
                key={item.workspaceId}
                type="button"
                role="option"
                data-testid={`people-workspace-picker-item-${item.workspaceId}`}
                className="rounded-md border border-border/70 bg-background px-2 py-1.5 text-left text-xs hover:bg-muted/40"
                disabled={busy || !api}
                onClick={() => void selectWorkspace(item.workspaceId)}
              >
                <div className="font-medium text-text-strong">{item.displayName}</div>
                <div className="text-muted-foreground">
                  {item.role ?? t("peopleWorkspaceRoleUnknown")}
                  {item.membershipActive ? "" : ` · ${t("peopleWorkspaceMembershipInactive")}`}
                </div>
              </button>
            ))}
          </div>
        ) : null}

        <p className="text-xs text-muted-foreground" data-testid="people-invite-trust-note">
          {mode === "setup" ? t("peopleSetupCodeTrustNote") : t("peopleInvitationBearerTrustNote")}
        </p>
        {status?.credentialStorage === "unavailable" || status?.nonPersistenceWarning ? (
          <p
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-900 dark:text-amber-100"
            data-testid="people-session-only-warning"
            role="status"
          >
            {t("peopleSessionOnlyCredentialWarning")}
          </p>
        ) : null}

        <div
          className="flex w-fit max-w-full flex-wrap gap-1 rounded-lg bg-muted/60 p-1"
          role="tablist"
          aria-label={t("peopleConnectModes")}
        >
          {(
            [
              ["setup", "peopleConnectSetupCode"],
              ["join", "peopleConnectJoin"],
              ["bootstrap", "peopleConnectBootstrap"],
              ["connect", "peopleConnectExisting"]
            ] as const
          ).map(([value, labelKey]) => (
            <Button
              key={value}
              type="button"
              role="tab"
              size="sm"
              variant={mode === value ? "secondary" : "ghost"}
              className={mode === value ? "bg-background shadow-sm hover:bg-background" : undefined}
              data-testid={`people-connect-mode-${value}`}
              aria-selected={mode === value}
              onClick={() => setMode(value)}
            >
              {t(labelKey)}
            </Button>
          ))}
        </div>

        {mode === "setup" ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${formId}-name`}>{t("peopleDisplayName")}</Label>
              <Input
                id={`${formId}-name`}
                data-testid="people-connect-display-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoComplete="nickname"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${formId}-url`}>{t("peopleServerUrl")}</Label>
              <Input
                id={`${formId}-url`}
                data-testid="people-connect-server-url"
                value={serverBaseUrl}
                onChange={(event) => setServerBaseUrl(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${formId}-setup`}>{t("peopleSetupCode")}</Label>
              <Input
                id={`${formId}-setup`}
                data-testid="people-connect-setup-code"
                ref={setupCodeInputRef}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                data-testid="people-connect-allow-insecure"
                checked={allowInsecureTransport}
                onChange={(event) => setAllowInsecureTransport(event.target.checked)}
              />
              {t("peopleAllowInsecureTransport")}
            </label>
          </div>
        ) : null}

        {mode === "join" || mode === "bootstrap" ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${formId}-name-legacy`}>{t("peopleDisplayName")}</Label>
              <Input
                id={`${formId}-name-legacy`}
                data-testid="people-connect-display-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoComplete="nickname"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${formId}-url-legacy`}>{t("peopleServerUrl")}</Label>
              <Input
                id={`${formId}-url-legacy`}
                data-testid="people-connect-server-url"
                value={serverBaseUrl}
                onChange={(event) => setServerBaseUrl(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${formId}-project`}>{t("peopleProjectId")}</Label>
              <Input
                id={`${formId}-project`}
                data-testid="people-connect-project-id"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            {mode === "join" ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${formId}-token`}>{t("peopleInvitationToken")}</Label>
                <Input
                  id={`${formId}-token`}
                  data-testid="people-connect-invitation-token"
                  value={invitationToken}
                  onChange={(event) => setInvitationToken(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            ) : null}
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                data-testid="people-connect-allow-insecure"
                checked={allowInsecureTransport}
                onChange={(event) => setAllowInsecureTransport(event.target.checked)}
              />
              {t("peopleAllowInsecureTransport")}
            </label>
          </div>
        ) : null}

        {mode === "connect" ? (
          <div className="rounded-md border border-border/70 bg-muted/20 px-2 py-1.5 text-xs">
            {activeProfile || workspaceConnection?.profile ? (
              <div data-testid="people-connect-active-profile">
                <div className="font-medium text-text-strong">
                  {workspaceConnection?.workspaceDisplayName ?? activeProfile?.displayName}
                </div>
                <div className="text-muted-foreground">
                  {workspaceConnection?.profile?.serverBaseUrl ?? activeProfile?.serverBaseUrl}
                </div>
                {activeProfile?.projectId ? (
                  <div className="text-muted-foreground">{activeProfile.projectId}</div>
                ) : null}
                {workspaceConnection?.workspaceId ? (
                  <div className="text-muted-foreground">{workspaceConnection.workspaceId}</div>
                ) : null}
                <div className="text-muted-foreground">
                  {activeProfile?.hasDeviceCredential ||
                  workspaceConnection?.status === "connected" ||
                  workspaceConnection?.status === "disconnected"
                    ? t("peopleCredentialPresent")
                    : t("peopleMissingCredential")}
                </div>
              </div>
            ) : (
              <div data-testid="people-connect-no-profile">{t("peopleNoProfileToConnect")}</div>
            )}
          </div>
        ) : null}

        {error ? (
          <div
            className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
            data-testid="people-connect-error"
            role="alert"
          >
            {error}
          </div>
        ) : null}
        {info ? (
          <div
            className="rounded-md border border-border/70 bg-muted/30 px-2 py-1.5 text-xs"
            data-testid="people-connect-info"
            role="status"
          >
            {info}
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          {onRequestClose ? (
            <Button type="button" size="sm" variant="ghost" onClick={onRequestClose}>
              {t("peopleClose")}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            disabled={busy || !api}
            data-testid="people-connect-submit"
            onClick={() => void submit()}
          >
            {busy ? t("peopleWorking") : submitLabel}
          </Button>
        </div>
      </div>
    </section>
  );
}
