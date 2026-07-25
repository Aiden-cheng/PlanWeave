import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { createTranslator } from "../i18n";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import { collaborationErrorMessage } from "../collaboration/formatCollaborationError";

export type CollaborationConnectFormProps = {
  api: PlanWeaveCollaborationApi | null;
  status: CollaborationStatus | null;
  t: ReturnType<typeof createTranslator>;
  onConnected?: () => void;
  /** Restore focus to the people trigger after successful close actions. */
  onRequestClose?: () => void;
};

type ConnectMode = "join" | "bootstrap" | "connect";

function newProfileId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `profile-${crypto.randomUUID()}`;
  }
  return `profile-${Date.now()}`;
}

/**
 * Minimal join / bootstrap / connect onboarding.
 * Honest about invitation bearer trust and safeStorage/session-only status.
 */
export function CollaborationConnectForm({
  api,
  status,
  t,
  onConnected,
  onRequestClose
}: CollaborationConnectFormProps) {
  const formId = useId();
  const [mode, setMode] = useState<ConnectMode>("join");
  const [displayName, setDisplayName] = useState("");
  const [serverBaseUrl, setServerBaseUrl] = useState("https://");
  const [projectId, setProjectId] = useState("");
  const [invitationToken, setInvitationToken] = useState("");
  const [allowInsecureTransport, setAllowInsecureTransport] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const profiles = status?.profiles ?? [];
  const activeProfile =
    profiles.find((profile) => profile.profileId === status?.activeProfileId) ??
    profiles[0] ??
    null;

  const submit = async () => {
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (mode === "connect") {
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

  return (
    <div className="flex flex-col gap-3" data-testid="people-connect-form">
      <p className="text-xs text-muted-foreground" data-testid="people-invite-trust-note">
        {t("peopleInvitationBearerTrustNote")}
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

      <div className="flex flex-wrap gap-1" role="tablist" aria-label={t("peopleConnectModes")}>
        {(
          [
            ["join", "peopleConnectJoin"],
            ["bootstrap", "peopleConnectBootstrap"],
            ["connect", "peopleConnectExisting"]
          ] as const
        ).map(([value, labelKey]) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={mode === value ? "secondary" : "ghost"}
            data-testid={`people-connect-mode-${value}`}
            aria-selected={mode === value}
            onClick={() => setMode(value)}
          >
            {t(labelKey)}
          </Button>
        ))}
      </div>

      {mode !== "connect" ? (
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
      ) : (
        <div className="rounded-md border border-border/70 bg-muted/20 px-2 py-1.5 text-xs">
          {activeProfile ? (
            <div data-testid="people-connect-active-profile">
              <div className="font-medium text-text-strong">{activeProfile.displayName}</div>
              <div className="text-muted-foreground">{activeProfile.serverBaseUrl}</div>
              <div className="text-muted-foreground">{activeProfile.projectId}</div>
              <div className="text-muted-foreground">
                {activeProfile.hasDeviceCredential
                  ? t("peopleCredentialPresent")
                  : t("peopleMissingCredential")}
              </div>
            </div>
          ) : (
            <div data-testid="people-connect-no-profile">{t("peopleNoProfileToConnect")}</div>
          )}
        </div>
      )}

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
          {busy ? t("peopleWorking") : t("peopleConnectSubmit")}
        </Button>
      </div>
    </div>
  );
}
