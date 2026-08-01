import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CollaborationContentBootstrapResult,
  CollaborationProfileView,
  LocalCollaborationServerStatus,
  PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";
import { collaborationBridge } from "../bridge";
import type { createTranslator } from "../i18n";
import { useCollaborationReadModels } from "../hooks/useCollaborationReadModels";
import { useCollaborationStatus } from "../hooks/useCollaborationStatus";
import { usePeoplePanelController } from "../hooks/usePeoplePanelController";
import { CollaborationConnectForm } from "../team/CollaborationConnectForm";
import { buildCollaborationDiagnosticReport } from "../team/collaborationDiagnostics";
import { CollaborationWorkspaceOnboarding } from "../team/CollaborationWorkspaceOnboarding";
import { PeoplePanel } from "../team/PeoplePanel";
import { ContentAuthorityPanel } from "../collaboration/ContentAuthorityPanel";
import {
  CurrentCanvasAccessPanel,
  CurrentCanvasMemberAccess
} from "../collaboration/CurrentCanvasAccessPanel";
import { LocalCollaborationServerPanel } from "../collaboration/LocalCollaborationServerPanel";
import { useCurrentCanvasAccess } from "../hooks/useCurrentCanvasAccess";
import { isCollaborationSessionConnected } from "../collaboration/sessionState";
import {
  collaborationErrorCode,
  collaborationErrorMessage
} from "../collaboration/formatCollaborationError";
import type { DesktopUiSettings } from "../types";

type PeopleSection = "workspace" | "hosting";

export type PeopleViewProps = {
  t: ReturnType<typeof createTranslator>;
  /** Injected API for tests. */
  api?: PlanWeaveCollaborationApi | null;
  /** Optional clipboard writer; defaults to navigator.clipboard. */
  copyText?: (text: string) => Promise<void>;
  localProjectId?: string | null;
  canvasId?: string | null;
  onContentMaterialized?: () => Promise<void>;
  onContentReplicaReady?: (result: CollaborationContentBootstrapResult) => Promise<void>;
  onMembershipOutcome?: (outcome: { ok: boolean; message: string }) => void;
  collaborationScopeLayout: DesktopUiSettings["layout"]["collaborationScope"];
  onCollaborationScopeLayoutChange: (
    patch: Partial<DesktopUiSettings["layout"]["collaborationScope"]>
  ) => void;
  localInvitationHandoff?: string | null;
  onLocalInvitationHandoffChange?: (handoff: string | null) => void;
};

async function defaultCopyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error("clipboard_unavailable");
}

function isLoopbackServerUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

function sameServerOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

export function resolveCollaborationInvitationServerBaseUrl(
  activeProfile: CollaborationProfileView | null,
  localServerStatus: LocalCollaborationServerStatus | null
): string | undefined {
  if (!activeProfile) return undefined;
  const localProfile = localServerStatus?.profile;
  if (
    localServerStatus?.state === "running" &&
    localProfile &&
    localServerStatus.lanSharingEnabled &&
    localServerStatus.lanServerBaseUrl &&
    isLoopbackServerUrl(activeProfile.serverBaseUrl) &&
    sameServerOrigin(localProfile.serverBaseUrl, activeProfile.serverBaseUrl)
  ) {
    return localServerStatus.lanServerBaseUrl;
  }
  return activeProfile.serverBaseUrl;
}

export function formatPeoplePanelError(
  t: ReturnType<typeof createTranslator>,
  error: unknown
): string {
  const code = collaborationErrorCode(error);
  if (code === "human_rate_limited") return t("peopleRequestRateLimited");
  if (code === "human_limit_exceeded") return t("localServerInvitationCapacityExceeded");
  return collaborationErrorMessage(error);
}

/** Active-project member administration surface. */
export function PeopleView({
  t,
  api: apiProp,
  copyText = defaultCopyText,
  localProjectId = null,
  canvasId = null,
  onContentMaterialized,
  onContentReplicaReady,
  onMembershipOutcome,
  collaborationScopeLayout,
  onCollaborationScopeLayoutChange,
  localInvitationHandoff: controlledLocalInvitationHandoff,
  onLocalInvitationHandoffChange
}: PeopleViewProps) {
  const api = apiProp === undefined ? collaborationBridge : apiProp;
  const [section, setSection] = useState<PeopleSection>("workspace");
  const [localHostingOpen, setLocalHostingOpen] = useState(false);
  const [revealInvitationManagement, setRevealInvitationManagement] = useState(false);
  const [internalLocalInvitationHandoff, setInternalLocalInvitationHandoff] = useState<
    string | null
  >(null);
  const localInvitationHandoff =
    controlledLocalInvitationHandoff === undefined
      ? internalLocalInvitationHandoff
      : controlledLocalInvitationHandoff;
  const setLocalInvitationHandoff =
    onLocalInvitationHandoffChange ?? setInternalLocalInvitationHandoff;
  const [localServerStatus, setLocalServerStatus] = useState<LocalCollaborationServerStatus | null>(
    null
  );
  const {
    status,
    loading: collaborationStatusLoading,
    error: collaborationStatusError,
    refresh: refreshCollaborationStatus
  } = useCollaborationStatus({ api });

  useEffect(() => {
    if (!api) return;
    void api
      .getLocalCollaborationServerStatus()
      .then(setLocalServerStatus)
      .catch((error: unknown) => {
        console.error("Failed to read local collaboration sharing status.", error);
      });
  }, [api]);

  const activeProfile = useMemo(() => {
    if (!status?.activeProfileId) return null;
    return status.profiles.find((profile) => profile.profileId === status.activeProfileId) ?? null;
  }, [status]);

  const sessionConnected = isCollaborationSessionConnected(status);
  const workspaceConnectionActive =
    status?.workspaceConnection.status === "connecting" ||
    status?.workspaceConnection.status === "connected" ||
    status?.workspaceConnection.status === "reconnecting";
  const hasConfiguredWorkspace =
    activeProfile?.hasDeviceCredential === true || workspaceConnectionActive;
  const showOnboarding = !hasConfiguredWorkspace;

  useEffect(() => {
    if (hasConfiguredWorkspace && localHostingOpen) {
      setLocalHostingOpen(false);
    }
  }, [hasConfiguredWorkspace, localHostingOpen]);

  const invitationServerBaseUrl = resolveCollaborationInvitationServerBaseUrl(
    activeProfile,
    localServerStatus
  );
  const handleLocalServerStatusChange = useCallback(
    (nextStatus: LocalCollaborationServerStatus) => {
      setLocalServerStatus(nextStatus);
      if (localHostingOpen && nextStatus.state === "running") {
        void refreshCollaborationStatus();
      }
    },
    [localHostingOpen, refreshCollaborationStatus]
  );
  const currentCanvasAccess = useCurrentCanvasAccess({ api, canvasId, status });
  const formatPanelError = useCallback((error: unknown) => formatPeoplePanelError(t, error), [t]);

  // Subscribe only: the project shell owns the shared hub's active project/canvas binding.
  const { snapshot, viewModel, controller } = useCollaborationReadModels({
    api,
    profileId: sessionConnected ? (activeProfile?.profileId ?? null) : null,
    projectId: sessionConnected ? (activeProfile?.projectId ?? null) : null,
    manageActiveProject: false
  });

  const panel = usePeoplePanelController({
    api,
    status,
    members: viewModel.members,
    hosts: viewModel.hosts,
    syncPhase: snapshot.syncPhase,
    detailsOpen: true,
    formatError: formatPanelError
  });
  const diagnosticReport = useMemo(
    () =>
      status
        ? buildCollaborationDiagnosticReport(status, undefined, snapshot, currentCanvasAccess.view)
        : null,
    [currentCanvasAccess.view, snapshot, status]
  );

  const handleManageInvitations = useCallback(() => {
    setLocalHostingOpen(false);
    setRevealInvitationManagement(true);
    setSection("workspace");
    void panel.refreshDetails();
  }, [panel.refreshDetails]);

  const refreshMembers = async () => {
    if (controller && activeProfile) {
      await controller.refreshAuthoritative({ reason: "people_member_mutation" });
    }
  };

  const reportMembership = (ok: boolean, message: string) => {
    onMembershipOutcome?.({ ok, message });
  };

  const membershipResult = (ok: boolean) =>
    ok ? t("notifyMembershipChanged") : (panel.actionError ?? t("peopleError"));

  return (
    <section
      className="h-full min-h-0 w-full overflow-y-auto"
      data-testid="people-view"
      aria-label={t("peopleTitle")}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col px-5 pb-12 pt-1 sm:px-7 lg:px-9">
        {collaborationStatusLoading && !status ? (
          <div className="py-8 text-xs text-muted-foreground" role="status">
            {t("peopleWorking")}
          </div>
        ) : showOnboarding ? (
          <>
            {collaborationStatusError ? (
              <div
                className="mb-5 border-l-2 border-destructive pl-3 text-xs text-destructive"
                role="alert"
              >
                {collaborationStatusError}
              </div>
            ) : null}
            <CollaborationWorkspaceOnboarding
              t={t}
              onLocalHostingOpenChange={setLocalHostingOpen}
              localHostingSlot={
                <LocalCollaborationServerPanel
                  api={api}
                  t={t}
                  projectId={null}
                  canvasId={canvasId}
                  scopeLayout={collaborationScopeLayout}
                  onScopeLayoutChange={onCollaborationScopeLayoutChange}
                  copyText={copyText}
                  invitationHandoff={localInvitationHandoff}
                  onInvitationHandoffChange={setLocalInvitationHandoff}
                  onManageInvitations={handleManageInvitations}
                  onStatusChange={handleLocalServerStatusChange}
                />
              }
              existingServerSlot={
                <CollaborationConnectForm
                  api={api}
                  status={status}
                  t={t}
                  fixedMode="setup"
                  showHeader={false}
                  showConnectionSummary
                  copyText={copyText}
                  onConnected={refreshCollaborationStatus}
                />
              }
              joinSlot={
                <CollaborationConnectForm
                  api={api}
                  status={status}
                  t={t}
                  fixedMode="join"
                  showHeader={false}
                  showConnectionSummary={false}
                  copyText={copyText}
                  onConnected={refreshCollaborationStatus}
                />
              }
            />
          </>
        ) : (
          <>
            <nav
              className="mb-7 flex items-end gap-7 border-b border-border/70 px-1 pt-1"
              data-testid="people-section-nav"
              aria-label={t("peopleSections")}
            >
              {(["workspace", "hosting"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`relative pb-3 text-sm font-semibold tracking-[-0.01em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    section === value
                      ? "text-text-strong after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-text-strong"
                      : "text-muted-foreground hover:text-text-strong"
                  }`}
                  data-testid={`people-section-${value}`}
                  aria-current={section === value ? "page" : undefined}
                  onClick={() => setSection(value)}
                >
                  {t(value === "workspace" ? "peopleSectionWorkspace" : "peopleSectionHosting")}
                </button>
              ))}
            </nav>

            {section === "workspace" ? (
              <div className="flex flex-col gap-6" data-testid="people-workspace-section">
                <PeoplePanel
                  mode={panel.mode}
                  presence={panel.presence}
                  members={panel.members}
                  invitations={panel.invitations}
                  devices={panel.devices}
                  detailsLoading={panel.detailsLoading}
                  detailsError={panel.detailsError}
                  actionError={panel.actionError}
                  actionBusy={panel.actionBusy}
                  pendingInvitation={panel.pendingInvitation}
                  revealInvitationManagement={revealInvitationManagement}
                  invitationConnection={
                    activeProfile
                      ? {
                          serverBaseUrl: invitationServerBaseUrl ?? activeProfile.serverBaseUrl,
                          projectId: activeProfile.projectId
                        }
                      : null
                  }
                  showTitle={false}
                  diagnosticReport={diagnosticReport}
                  onCopyDiagnostics={copyText}
                  t={t}
                  onCreateInvitation={panel.createInvitation}
                  onViewInvitation={panel.viewInvitation}
                  onCopyInvitationToken={copyText}
                  onDismissPendingInvitation={panel.clearPendingInvitation}
                  onRevokeInvitation={async (invitationId) => {
                    const ok = await panel.revokeInvitation(invitationId);
                    reportMembership(ok, membershipResult(ok));
                    return ok;
                  }}
                  onRevokeInvitations={async (invitationIds) => {
                    const ok = await panel.revokeInvitations(invitationIds);
                    reportMembership(ok, membershipResult(ok));
                    return ok;
                  }}
                  onPromoteMember={async (humanPrincipalId) => {
                    const ok = await panel.promoteMember(humanPrincipalId);
                    if (ok) await refreshMembers();
                    reportMembership(ok, membershipResult(ok));
                    return ok;
                  }}
                  onDemoteMember={async (humanPrincipalId) => {
                    const ok = await panel.demoteMember(humanPrincipalId);
                    if (ok) await refreshMembers();
                    reportMembership(ok, membershipResult(ok));
                    return ok;
                  }}
                  onRemoveMember={async (humanPrincipalId) => {
                    const ok = await panel.removeMember(humanPrincipalId);
                    if (ok) await refreshMembers();
                    reportMembership(ok, membershipResult(ok));
                    return ok;
                  }}
                  onRevokeDevice={async (deviceCredentialId) => {
                    const ok = await panel.revokeDevice(deviceCredentialId);
                    reportMembership(ok, membershipResult(ok));
                    return ok;
                  }}
                  onRefreshDetails={async () => {
                    await panel.refreshDetails();
                    await refreshMembers();
                  }}
                  renderMemberAccess={(member) => {
                    if (currentCanvasAccess.loading && !currentCanvasAccess.view) {
                      return <p className="text-xs text-muted-foreground">{t("accessLoading")}</p>;
                    }
                    const person = currentCanvasAccess.view?.people.find(
                      (candidate) => candidate.humanPrincipalId === member.humanPrincipalId
                    );
                    if (!currentCanvasAccess.view || !person) {
                      return (
                        <p className="text-xs text-muted-foreground">
                          {currentCanvasAccess.error ?? t("accessMemberUnavailable")}
                        </p>
                      );
                    }
                    return (
                      <CurrentCanvasMemberAccess
                        view={currentCanvasAccess.view}
                        person={person}
                        busy={currentCanvasAccess.busy}
                        t={t}
                        onGrant={currentCanvasAccess.grant}
                        onRevoke={currentCanvasAccess.revoke}
                      />
                    );
                  }}
                  connectSlot={
                    <CollaborationConnectForm
                      api={api}
                      status={status}
                      t={t}
                      initialMode={activeProfile ? "connect" : "join"}
                      copyText={copyText}
                      onConnected={refreshCollaborationStatus}
                    />
                  }
                />
              </div>
            ) : (
              <div className="flex flex-col" data-testid="people-hosting-section">
                <LocalCollaborationServerPanel
                  api={api}
                  t={t}
                  projectId={activeProfile?.projectId ?? null}
                  canvasId={canvasId}
                  scopeLayout={collaborationScopeLayout}
                  onScopeLayoutChange={onCollaborationScopeLayoutChange}
                  copyText={copyText}
                  invitationHandoff={localInvitationHandoff}
                  onInvitationHandoffChange={setLocalInvitationHandoff}
                  onManageInvitations={handleManageInvitations}
                  onStatusChange={handleLocalServerStatusChange}
                />
                <CurrentCanvasAccessPanel
                  view={currentCanvasAccess.view}
                  loading={currentCanvasAccess.loading}
                  error={currentCanvasAccess.error}
                  busy={currentCanvasAccess.busy}
                  t={t}
                  onRefresh={currentCanvasAccess.refresh}
                  onUpdateVisibility={currentCanvasAccess.updateVisibility}
                />
                <ContentAuthorityPanel
                  api={api ?? null}
                  connectionKey={activeProfile?.profileId ?? null}
                  authorityProjectId={activeProfile?.projectId ?? null}
                  localProjectId={localProjectId}
                  canvasId={canvasId}
                  connected={sessionConnected}
                  onMaterialized={onContentMaterialized}
                  onReplicaReady={onContentReplicaReady}
                  t={t}
                />
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
