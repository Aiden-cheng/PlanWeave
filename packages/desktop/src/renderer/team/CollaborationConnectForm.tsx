import { useId, useRef, useState } from "react";
import { ServerIcon } from "lucide-react";
import { parseCollaborationSetupHandoffV1 } from "@planweave-ai/collaboration-protocol/handoff/setup";
import {
  type ActiveWorkspaceConnectionView,
  type WorkspacePickerItem
} from "@planweave-ai/collaboration-protocol/connection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { createTranslator } from "../i18n";
import {
  collaborationRedeemSetupCodeInputSchema,
  collaborationUpsertProfileInputSchema,
  type CollaborationStatus,
  type PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";
import {
  collaborationConnectionErrorMessage,
  collaborationErrorMessage
} from "../collaboration/formatCollaborationError";
import { parseCollaborationInvitationHandoff } from "./collaborationInvitationHandoff";
import { CollaborationInvitationJoinFields } from "./CollaborationInvitationJoinFields";
import { CollaborationSetupHandoffFields } from "./CollaborationSetupHandoffFields";
import {
  buildCollaborationDiagnosticReport,
  shouldShowCollaborationDiagnostics
} from "./collaborationDiagnostics";

export type CollaborationConnectFormProps = {
  api: PlanWeaveCollaborationApi | null;
  status: CollaborationStatus | null;
  t: ReturnType<typeof createTranslator>;
  onConnected?: () => void | Promise<void>;
  /** Restore focus to the people trigger after successful close actions. */
  onRequestClose?: () => void;
  /** Preferred entry point for the surrounding surface. */
  initialMode?: ConnectMode;
  /** Lock the form to one product flow and hide the protocol-oriented mode switcher. */
  fixedMode?: ConnectMode;
  /** Embedded onboarding already supplies the section heading. */
  showHeader?: boolean;
  /** Embedded onboarding does not need the stored Workspace summary. */
  showConnectionSummary?: boolean;
  /** Clipboard boundary supplied by the containing desktop view. */
  copyText?: (text: string) => Promise<void>;
};

export type ConnectMode = "setup" | "join" | "bootstrap" | "connect";

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
  onRequestClose,
  initialMode = "setup",
  fixedMode,
  showHeader = true,
  showConnectionSummary = true,
  copyText
}: CollaborationConnectFormProps) {
  const formId = useId();
  const [mode, setMode] = useState<ConnectMode>(fixedMode ?? initialMode);
  const [displayName, setDisplayName] = useState("");
  const [serverBaseUrl, setServerBaseUrl] = useState("https://");
  const [projectId, setProjectId] = useState("");
  const [invitationToken, setInvitationToken] = useState("");
  const [invitationDetails, setInvitationDetails] = useState("");
  const [manualJoinOpen, setManualJoinOpen] = useState(
    !fixedMode && (fixedMode ?? initialMode) === "join"
  );
  const [manualSetupOpen, setManualSetupOpen] = useState(false);
  const setupHandoffInputRef = useRef<HTMLTextAreaElement>(null);
  const setupCodeInputRef = useRef<HTMLInputElement>(null);
  const [allowInsecureTransport, setAllowInsecureTransport] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
  const [existingServerAddressEdit, setExistingServerAddressEdit] = useState<{
    profileId: string;
    value: string;
  } | null>(null);

  const profiles = status?.profiles ?? [];
  const activeProfile =
    profiles.find((profile) => profile.profileId === status?.activeProfileId) ??
    profiles[0] ??
    null;
  const workspaceConnection = status?.workspaceConnection ?? null;
  const workspacePickerItems: WorkspacePickerItem[] = status?.workspacePicker?.items ?? [];
  const diagnosticReport =
    status && shouldShowCollaborationDiagnostics()
      ? buildCollaborationDiagnosticReport(status)
      : null;
  const existingServerBaseUrl =
    activeProfile && existingServerAddressEdit?.profileId === activeProfile.profileId
      ? existingServerAddressEdit.value
      : (activeProfile?.serverBaseUrl ?? "");
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
        const setupHandoffInput = setupHandoffInputRef.current;
        const completeSetupDetails = setupHandoffInput?.value.trim() ?? "";
        if (setupHandoffInput) setupHandoffInput.value = "";

        let effectiveServerBaseUrl = serverBaseUrl.trim();
        let effectiveSetupCode = "";
        let effectiveAllowInsecureTransport = allowInsecureTransport;
        if (completeSetupDetails) {
          const handoff = parseCollaborationSetupHandoffV1(completeSetupDetails);
          if (!handoff) {
            setError(t("peopleSetupDetailsInvalid"));
            return;
          }
          effectiveServerBaseUrl = handoff.serverBaseUrl;
          effectiveSetupCode = handoff.setupCode;
          effectiveAllowInsecureTransport = handoff.allowInsecureTransport;
        } else if (!manualSetupOpen) {
          setError(t("peopleSetupDetailsInvalid"));
          return;
        } else {
          const setupCodeInput = setupCodeInputRef.current;
          if (!setupCodeInput) {
            throw new Error("Setup code input is unavailable.");
          }
          effectiveSetupCode = setupCodeInput.value.trim();
          setupCodeInput.value = "";
        }
        const candidate = {
          serverBaseUrl: effectiveServerBaseUrl,
          allowInsecureTransport: effectiveAllowInsecureTransport,
          setupCode: effectiveSetupCode,
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
        await onConnected?.();
        return;
      }

      if (mode === "connect") {
        if (!activeProfile) {
          throw new Error(t("peopleNoProfileToConnect"));
        }
        if (!activeProfile.hasDeviceCredential) {
          throw new Error(t("peopleMissingCredential"));
        }
        const updatedProfile = collaborationUpsertProfileInputSchema.safeParse({
          profileId: activeProfile.profileId,
          displayName: activeProfile.displayName,
          serverBaseUrl: existingServerBaseUrl.trim(),
          projectId: activeProfile.projectId,
          allowInsecureTransport: activeProfile.allowInsecureTransport
        });
        if (!updatedProfile.success) {
          setError(t("peopleServerUrlInvalid"));
          return;
        }
        if (updatedProfile.data.serverBaseUrl !== activeProfile.serverBaseUrl) {
          await api.upsertCollaborationProfile(updatedProfile.data);
        }
        let workspaceConnectError: unknown = null;
        if (
          workspaceConnection?.status === "disconnected" ||
          workspaceConnection?.status === "error"
        ) {
          try {
            await api.connectWorkspaceConnection();
          } catch (caught) {
            // A Workspace connection is optional for a stored project profile. Preserve its
            // independent error state, but do not prevent the project session from connecting.
            workspaceConnectError = caught;
          }
        }
        await api.setActiveCollaborationProfile({ profileId: activeProfile.profileId });
        await api.connectCollaborationSession({ profileId: activeProfile.profileId });
        if (workspaceConnectError) {
          setInfo(
            `${t("peopleWorkspaceError")}: ${collaborationConnectionErrorMessage(t, workspaceConnectError)}`
          );
        }
        await onConnected?.();
        return;
      }

      let effectiveServerBaseUrl = serverBaseUrl.trim() || activeProfile?.serverBaseUrl || "";
      let effectiveProjectId = projectId.trim() || activeProfile?.projectId || "";
      let effectiveInvitationToken = invitationToken.trim();
      let effectiveAllowInsecureTransport = allowInsecureTransport;
      if (mode === "join" && invitationDetails.trim()) {
        const handoff = parseCollaborationInvitationHandoff(invitationDetails);
        if (!handoff) {
          setError(t("peopleInvitationDetailsInvalid"));
          return;
        }
        effectiveServerBaseUrl = handoff.serverBaseUrl;
        effectiveProjectId = handoff.projectId;
        effectiveInvitationToken = handoff.invitationToken;
        effectiveAllowInsecureTransport = handoff.allowInsecureTransport;
      } else if (mode === "join" && !manualJoinOpen) {
        setError(t("peopleInvitationDetailsInvalid"));
        return;
      }

      const profileId =
        mode === "join" ? newProfileId() : (activeProfile?.profileId ?? newProfileId());
      const profileDisplayName =
        displayName.trim() ||
        (mode === "join" ? t("peopleDefaultProfileName") : activeProfile?.displayName) ||
        t("peopleDefaultProfileName");
      await api.upsertCollaborationProfile({
        profileId,
        displayName: profileDisplayName,
        serverBaseUrl: effectiveServerBaseUrl,
        projectId: effectiveProjectId,
        allowInsecureTransport: effectiveAllowInsecureTransport
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
            invitationToken: effectiveInvitationToken,
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
      setInvitationDetails("");
      await onConnected?.();
    } catch (submitError) {
      setError(collaborationConnectionErrorMessage(t, submitError));
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
      await onConnected?.();
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
      await onConnected?.();
    } catch (retryError) {
      setError(collaborationConnectionErrorMessage(t, retryError));
    } finally {
      setBusy(false);
    }
  };

  const copyDiagnostics = async () => {
    if (!copyText || !diagnosticReport) return;
    try {
      await copyText(diagnosticReport);
      setDiagnosticsCopied(true);
    } catch {
      setError(t("peopleConnectionDiagnosticsCopyFailed"));
    }
  };

  return (
    <section
      className="max-w-4xl"
      data-testid="people-connect-form"
      aria-label={showHeader ? undefined : t("peopleRemoteWorkspaceTitle")}
      aria-labelledby={showHeader ? "people-remote-workspace-title" : undefined}
    >
      {showHeader ? (
        <div className="flex items-start gap-3 border-b border-border/70 pb-5">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center text-sky-700 dark:text-sky-300">
            <ServerIcon className="size-4" aria-hidden="true" />
          </div>
          <div>
            <h2
              id="people-remote-workspace-title"
              className="text-sm font-semibold text-text-strong"
            >
              {t("peopleRemoteWorkspaceTitle")}
            </h2>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
              {t("peopleRemoteWorkspaceDescription")}
            </p>
          </div>
        </div>
      ) : null}
      <div className="flex flex-col gap-5 pt-5">
        {showConnectionSummary ? (
          <div
            className="border-l-2 border-border px-3 py-1 text-xs"
            data-testid="people-workspace-connection-status"
            data-status={workspaceConnection?.status ?? "local_only"}
            role="status"
          >
            <div className="font-medium text-text-strong">
              {workspaceStatusLabel(workspaceConnection, t)}
            </div>
            {workspaceConnection?.workspaceDisplayName ? (
              <div className="text-muted-foreground">
                {workspaceConnection.workspaceDisplayName}
              </div>
            ) : (
              <div className="text-muted-foreground">{t("peopleWorkspaceLocalOnlyHint")}</div>
            )}
            {workspaceConnection?.profile?.serverBaseUrl ? (
              <div className="text-muted-foreground">
                {workspaceConnection.profile.serverBaseUrl}
              </div>
            ) : null}
            {workspaceConnection?.status === "error" && workspaceConnection.error ? (
              <div
                className="mt-1 text-destructive"
                data-testid="people-workspace-connection-error"
              >
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
        ) : null}

        {showConnectionSummary && workspacePickerItems.length > 0 ? (
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

        {!fixedMode ? (
          <div
            className="flex max-w-full flex-wrap gap-x-6 border-b border-border/70"
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
                variant="ghost"
                className={`relative rounded-none px-0 pb-2.5 text-xs hover:bg-transparent ${
                  mode === value
                    ? "text-text-strong after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-text-strong"
                    : "text-muted-foreground"
                }`}
                data-testid={`people-connect-mode-${value}`}
                aria-selected={mode === value}
                onClick={() => {
                  setMode(value);
                  if (value === "join") setManualJoinOpen(true);
                }}
              >
                {t(labelKey)}
              </Button>
            ))}
          </div>
        ) : null}

        {mode === "setup" ? (
          <CollaborationSetupHandoffFields
            formId={formId}
            t={t}
            handoffInputRef={setupHandoffInputRef}
            setupCodeInputRef={setupCodeInputRef}
            displayName={displayName}
            manualOpen={manualSetupOpen}
            serverBaseUrl={serverBaseUrl}
            allowInsecureTransport={allowInsecureTransport}
            onDisplayNameChange={setDisplayName}
            onManualOpenChange={setManualSetupOpen}
            onServerBaseUrlChange={setServerBaseUrl}
            onAllowInsecureTransportChange={setAllowInsecureTransport}
          />
        ) : null}

        {mode === "join" ? (
          <CollaborationInvitationJoinFields
            formId={formId}
            t={t}
            invitationDetails={invitationDetails}
            displayName={displayName}
            manualJoinOpen={manualJoinOpen}
            serverBaseUrl={serverBaseUrl}
            projectId={projectId}
            invitationToken={invitationToken}
            allowInsecureTransport={allowInsecureTransport}
            onInvitationDetailsChange={setInvitationDetails}
            onDisplayNameChange={setDisplayName}
            onManualJoinOpenChange={setManualJoinOpen}
            onServerBaseUrlChange={setServerBaseUrl}
            onProjectIdChange={setProjectId}
            onInvitationTokenChange={setInvitationToken}
            onAllowInsecureTransportChange={setAllowInsecureTransport}
          />
        ) : null}

        {mode === "bootstrap" ? (
          <div className="grid grid-cols-1 gap-x-5 gap-y-3 md:grid-cols-2">
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
            <label className="flex items-center gap-2 text-xs text-muted-foreground md:col-span-2">
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
          <div className="border-y border-border/70 py-3 text-xs">
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
                {activeProfile ? (
                  <div className="mt-3 flex flex-col gap-1">
                    <Label htmlFor={`${formId}-existing-server-url`}>
                      {t("peopleExistingServerUrl")}
                    </Label>
                    <Input
                      id={`${formId}-existing-server-url`}
                      data-testid="people-connect-existing-server-url"
                      value={existingServerBaseUrl}
                      onChange={(event) =>
                        setExistingServerAddressEdit({
                          profileId: activeProfile.profileId,
                          value: event.target.value
                        })
                      }
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <p className="text-muted-foreground">
                      {t("peopleExistingServerUrlHint")}
                    </p>
                  </div>
                ) : null}
              </div>
            ) : (
              <div data-testid="people-connect-no-profile">{t("peopleNoProfileToConnect")}</div>
            )}
            {diagnosticReport ? (
              <details
                className="mt-3 border-t border-border/70 pt-3"
                data-testid="people-connection-diagnostics"
              >
                <summary className="cursor-pointer select-none font-medium text-text-strong">
                  {t("peopleConnectionDiagnostics")}
                </summary>
                <p className="mt-2 text-muted-foreground">
                  {t("peopleConnectionDiagnosticsHint")}
                </p>
                <pre
                  className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-5 text-text-strong"
                  data-testid="people-connection-diagnostics-report"
                >
                  {diagnosticReport}
                </pre>
                {copyText ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    data-testid="people-connection-diagnostics-copy"
                    onClick={() => void copyDiagnostics()}
                  >
                    {diagnosticsCopied
                      ? t("peopleConnectionDiagnosticsCopied")
                      : t("peopleConnectionDiagnosticsCopy")}
                  </Button>
                ) : null}
              </details>
            ) : null}
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
