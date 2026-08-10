import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  CollaborationContentBootstrapResult,
  LocalCollaborationServerStatus,
  PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";
import { isLocalCollaborationProfileId } from "../../shared/collaboration.js";
import type { DesktopServerExposureView } from "../../shared/deploymentExposure";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { collaborationBridge } from "../bridge";
import type { createTranslator } from "../i18n";
import { ContentAuthorityPanel } from "../collaboration/ContentAuthorityPanel";
import { LocalCollaborationServerPanel } from "../collaboration/LocalCollaborationServerPanel";
import { collaborationConnectionErrorMessage } from "../collaboration/formatCollaborationError";
import { useCollaborationStatus } from "../hooks/useCollaborationStatus";
import { isCollaborationSessionConnected } from "../collaboration/sessionState";
import type { DesktopUiSettings } from "../types";
import { DeploymentConnectionCard } from "./DeploymentConnectionCard";

async function defaultCopyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error("clipboard_unavailable");
}

function SettingGroup({
  children,
  title,
  titleAddon,
  description,
  testId
}: {
  children: ReactNode;
  title: string;
  titleAddon?: ReactNode;
  description?: string;
  testId?: string;
}) {
  return (
    <section className="flex flex-col gap-3" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-text-strong">{title}</h2>
        {titleAddon}
      </div>
      {description ? <p className="-mt-1 text-sm text-text-muted">{description}</p> : null}
      <FieldGroup className="gap-0 overflow-hidden rounded-md border border-border/80 bg-surface-raised shadow-sm">
        <div className="px-5 py-4">{children}</div>
      </FieldGroup>
    </section>
  );
}

export type SettingsServerSectionProps = {
  t: ReturnType<typeof createTranslator>;
  /** Injected API for tests. */
  api?: PlanWeaveCollaborationApi | null;
  copyText?: (text: string) => Promise<void>;
  localProjectId?: string | null;
  canvasId?: string | null;
  collaborationScopeLayout: DesktopUiSettings["layout"]["collaborationScope"];
  onCollaborationScopeLayoutChange: (
    patch: Partial<DesktopUiSettings["layout"]["collaborationScope"]>
  ) => void;
  onContentMaterialized?: () => Promise<void>;
  onContentReplicaReady?: (result: CollaborationContentBootstrapResult) => Promise<void>;
  /** Navigate to People so operators can manage invitations. */
  onManageInvitations?: () => void;
  showHeader?: boolean;
};

/**
 * Settings → Connections & Devices → Advanced connection: topology, local Server, and content authority.
 * Layout matches General / MCP: page title + SettingGroup (h2 + FieldGroup).
 */
export function SettingsServerSection({
  t,
  api: apiProp,
  copyText = defaultCopyText,
  localProjectId = null,
  canvasId = null,
  collaborationScopeLayout,
  onCollaborationScopeLayoutChange,
  onContentMaterialized,
  onContentReplicaReady,
  onManageInvitations,
  showHeader = true
}: SettingsServerSectionProps) {
  const api = apiProp === undefined ? collaborationBridge : apiProp;
  const [desktopServerExposure, setDesktopServerExposure] =
    useState<DesktopServerExposureView | null>(null);
  const [localInvitationHandoff, setLocalInvitationHandoff] = useState<string | null>(null);
  const [localServerRunning, setLocalServerRunning] = useState(false);
  const desktopServerExposureRef = useRef<DesktopServerExposureView | null>(null);

  const handleDesktopServerExposureChange = useCallback(
    (nextExposure: DesktopServerExposureView) => {
      const previousExposure = desktopServerExposureRef.current;
      const endpointChanged =
        previousExposure !== null &&
        (previousExposure.mode !== nextExposure.mode ||
          previousExposure.advertisedOrigin !== nextExposure.advertisedOrigin);
      desktopServerExposureRef.current = nextExposure;
      setDesktopServerExposure(nextExposure);
      if (endpointChanged) setLocalInvitationHandoff(null);
    },
    []
  );

  const { status, refresh: refreshCollaborationStatus } = useCollaborationStatus({ api });
  const [sessionReconnectBusy, setSessionReconnectBusy] = useState(false);
  const [sessionReconnectError, setSessionReconnectError] = useState<string | null>(null);

  const activeProfile = useMemo(() => {
    if (!status?.activeProfileId) return null;
    return status.profiles.find((profile) => profile.profileId === status.activeProfileId) ?? null;
  }, [status]);

  const sessionConnected = isCollaborationSessionConnected(status);
  const canReconnectSession = Boolean(api && activeProfile?.hasDeviceCredential);

  const reconnectCollaborationSession = useCallback(async () => {
    if (!api || !activeProfile?.hasDeviceCredential || sessionReconnectBusy) return;
    setSessionReconnectBusy(true);
    setSessionReconnectError(null);
    try {
      if (isLocalCollaborationProfileId(activeProfile.profileId)) {
        // Full local activation re-registers the trusted canvas and restores owner ACL.
        // Bare connectSession leaves content-authority routes returning forbidden.
        await api.registerLocalCollaborationCurrentProject({
          ...(localProjectId && canvasId
            ? { selection: { projectId: localProjectId, canvasId } }
            : {})
        });
      } else {
        await api.setActiveCollaborationProfile({ profileId: activeProfile.profileId });
        await api.connectCollaborationSession({ profileId: activeProfile.profileId });
      }
      await refreshCollaborationStatus();
    } catch (caught) {
      setSessionReconnectError(collaborationConnectionErrorMessage(t, caught));
    } finally {
      setSessionReconnectBusy(false);
    }
  }, [
    activeProfile,
    api,
    canvasId,
    localProjectId,
    refreshCollaborationStatus,
    sessionReconnectBusy,
    t
  ]);

  useEffect(() => {
    if (!api || typeof api.getDesktopServerExposure !== "function") return;
    let cancelled = false;
    void api.getDesktopServerExposure().then(
      (nextExposure) => {
        if (!cancelled) handleDesktopServerExposureChange(nextExposure);
      },
      () => {
        if (!cancelled) setDesktopServerExposure(null);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [api, handleDesktopServerExposureChange]);

  const handleLocalServerStatusChange = useCallback(
    (nextStatus: LocalCollaborationServerStatus) => {
      setLocalServerRunning(nextStatus.state === "running");
      if (nextStatus.state === "running") {
        void refreshCollaborationStatus();
      }
    },
    [refreshCollaborationStatus]
  );

  return (
    <section data-testid="settings-server-section" className="flex flex-col gap-6">
      {showHeader ? (
        <div>
          <h1 className="text-2xl font-semibold tracking-normal text-text-strong">
            {t("settingsServer")}
          </h1>
          <p className="mt-1 text-sm text-text-muted">{t("settingsServerHint")}</p>
        </div>
      ) : null}

      <div className="flex flex-col gap-6" data-testid="settings-server-panels">
        <SettingGroup
          testId="settings-server-connection-block"
          title={t("deploymentTitle")}
          description={t("deploymentDescription")}
        >
          <DeploymentConnectionCard
            presentation="embedded"
            t={t}
            onExposureChange={handleDesktopServerExposureChange}
          />
        </SettingGroup>

        <SettingGroup
          testId="settings-server-hosting-block"
          title={t("localServerTitle")}
          description={t("localServerDescription")}
          titleAddon={
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                localServerRunning
                  ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
                  : "bg-muted text-muted-foreground"
              }`}
              data-testid="settings-server-hosting-status"
            >
              <span
                className={`size-1.5 rounded-full ${
                  localServerRunning ? "bg-emerald-500" : "bg-muted-foreground/50"
                }`}
              />
              {localServerRunning ? t("localServerRunning") : t("localServerStopped")}
            </span>
          }
        >
          <LocalCollaborationServerPanel
            api={api}
            t={t}
            appearance="settings"
            projectId={localProjectId}
            canvasId={canvasId}
            scopeLayout={collaborationScopeLayout}
            onScopeLayoutChange={onCollaborationScopeLayoutChange}
            copyText={copyText}
            invitationHandoff={localInvitationHandoff}
            onInvitationHandoffChange={setLocalInvitationHandoff}
            onManageInvitations={onManageInvitations}
            onStatusChange={handleLocalServerStatusChange}
            serverExposure={desktopServerExposure}
          />
        </SettingGroup>

        <SettingGroup
          testId="settings-server-content-block"
          title={t("contentAuthorityTitle")}
          description={t("contentAuthorityDescription")}
        >
          {sessionConnected ? (
            <ContentAuthorityPanel
              api={api ?? null}
              appearance="settings"
              connectionKey={activeProfile?.profileId ?? null}
              authorityProjectId={activeProfile?.projectId ?? null}
              localProjectId={localProjectId}
              canvasId={canvasId}
              connected={sessionConnected}
              onMaterialized={onContentMaterialized}
              onReplicaReady={onContentReplicaReady}
              t={t}
            />
          ) : (
            <div
              className="flex flex-col gap-3"
              data-testid="settings-server-content-needs-session"
            >
              <p className="text-sm text-text-muted">{t("settingsServerContentNeedsSession")}</p>
              {sessionReconnectError ? (
                <p
                  className="text-xs text-destructive"
                  data-testid="settings-server-reconnect-error"
                  role="alert"
                >
                  {sessionReconnectError}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                {canReconnectSession ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={sessionReconnectBusy}
                    onClick={() => void reconnectCollaborationSession()}
                    data-testid="settings-server-reconnect-session"
                  >
                    {sessionReconnectBusy
                      ? t("settingsServerReconnectSessionBusy")
                      : t("settingsServerReconnectSession")}
                  </Button>
                ) : null}
                {onManageInvitations ? (
                  <Button
                    type="button"
                    size="sm"
                    variant={canReconnectSession ? "outline" : "default"}
                    onClick={onManageInvitations}
                    data-testid="settings-server-open-people"
                  >
                    {t("settingsServerOpenPeople")}
                  </Button>
                ) : null}
              </div>
            </div>
          )}
        </SettingGroup>
      </div>
    </section>
  );
}
