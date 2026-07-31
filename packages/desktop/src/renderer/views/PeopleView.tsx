import { useEffect, useMemo, useState } from "react";
import type {
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
import { CollaborationWorkspaceOnboarding } from "../team/CollaborationWorkspaceOnboarding";
import { PeoplePanel } from "../team/PeoplePanel";
import { ContentAuthorityPanel } from "../collaboration/ContentAuthorityPanel";
import { CurrentCanvasAccessPanel } from "../collaboration/CurrentCanvasAccessPanel";
import { LocalCollaborationServerPanel } from "../collaboration/LocalCollaborationServerPanel";
import { useCurrentCanvasAccess } from "../hooks/useCurrentCanvasAccess";
import { isCollaborationSessionConnected } from "../collaboration/sessionState";
import type { DesktopUiSettings } from "../types";

type PeopleSection = "workspace" | "hosting";

export type PeopleViewProps = {
  t: ReturnType<typeof createTranslator>;
  /** Injected API for tests. */
  api?: PlanWeaveCollaborationApi | null;
  /** Optional clipboard writer; defaults to navigator.clipboard. */
  copyText?: (text: string) => Promise<void>;
  canvasId?: string | null;
  onMembershipOutcome?: (outcome: { ok: boolean; message: string }) => void;
  collaborationScopeLayout: DesktopUiSettings["layout"]["collaborationScope"];
  onCollaborationScopeLayoutChange: (
    patch: Partial<DesktopUiSettings["layout"]["collaborationScope"]>
  ) => void;
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

/** Active-project member administration surface. */
export function PeopleView({
  t,
  api: apiProp,
  copyText = defaultCopyText,
  canvasId = null,
  onMembershipOutcome,
  collaborationScopeLayout,
  onCollaborationScopeLayoutChange
}: PeopleViewProps) {
  const api = apiProp === undefined ? collaborationBridge : apiProp;
  const [section, setSection] = useState<PeopleSection>("workspace");
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
  const showOnboarding =
    !collaborationStatusLoading && !sessionConnected && !workspaceConnectionActive;
  const invitationServerBaseUrl = resolveCollaborationInvitationServerBaseUrl(
    activeProfile,
    localServerStatus
  );
  const currentCanvasAccess = useCurrentCanvasAccess({ api, canvasId, status });

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
    detailsOpen: true
  });

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
      <div className="mx-auto flex w-full max-w-6xl flex-col pb-10">
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
              localHostingSlot={
                <LocalCollaborationServerPanel
                  key={`onboarding:${canvasId ?? "none"}`}
                  api={api}
                  t={t}
                  projectId={null}
                  canvasId={canvasId}
                  scopeLayout={collaborationScopeLayout}
                  onScopeLayoutChange={onCollaborationScopeLayoutChange}
                  copyText={copyText}
                  onStatusChange={setLocalServerStatus}
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
                  onConnected={() => void refreshCollaborationStatus()}
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
                  onConnected={() => void refreshCollaborationStatus()}
                />
              }
            />
          </>
        ) : (
          <>
            <nav
              className="mb-7 flex items-end gap-7 border-b border-border/70 px-1"
              aria-label={t("peopleSections")}
            >
              {(["workspace", "hosting"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`relative pb-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
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
              <div className="flex flex-col gap-8" data-testid="people-workspace-section">
                <PeoplePanel
                  mode={panel.mode}
                  presence={panel.presence}
                  members={panel.members}
                  hosts={panel.hosts}
                  invitations={panel.invitations}
                  devices={panel.devices}
                  detailsLoading={panel.detailsLoading}
                  detailsError={panel.detailsError}
                  actionError={panel.actionError}
                  actionBusy={panel.actionBusy}
                  pendingInvitation={panel.pendingInvitation}
                  invitationConnection={
                    activeProfile
                      ? {
                          serverBaseUrl: invitationServerBaseUrl ?? activeProfile.serverBaseUrl,
                          projectId: activeProfile.projectId
                        }
                      : null
                  }
                  showTitle={false}
                  t={t}
                  onCreateInvitation={panel.createInvitation}
                  onCopyInvitationToken={copyText}
                  onDismissPendingInvitation={panel.clearPendingInvitation}
                  onRevokeInvitation={async (invitationId) => {
                    const ok = await panel.revokeInvitation(invitationId);
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
                  connectSlot={
                    <CollaborationConnectForm
                      api={api}
                      status={status}
                      t={t}
                      initialMode={activeProfile ? "connect" : "join"}
                    />
                  }
                />
                <CurrentCanvasAccessPanel
                  view={currentCanvasAccess.view}
                  loading={currentCanvasAccess.loading}
                  error={currentCanvasAccess.error}
                  busy={currentCanvasAccess.busy}
                  t={t}
                  onRefresh={currentCanvasAccess.refresh}
                  onUpdateVisibility={currentCanvasAccess.updateVisibility}
                  onGrant={currentCanvasAccess.grant}
                  onRevoke={currentCanvasAccess.revoke}
                />
                <ContentAuthorityPanel
                  api={api ?? null}
                  canvasId={canvasId}
                  connected={sessionConnected}
                  t={t}
                />
              </div>
            ) : (
              <div className="flex flex-col gap-6" data-testid="people-hosting-section">
                <LocalCollaborationServerPanel
                  key={`${activeProfile?.profileId ?? "local"}:${canvasId ?? "none"}`}
                  api={api}
                  t={t}
                  projectId={activeProfile?.projectId ?? null}
                  canvasId={canvasId}
                  scopeLayout={collaborationScopeLayout}
                  onScopeLayoutChange={onCollaborationScopeLayoutChange}
                  copyText={copyText}
                  onStatusChange={setLocalServerStatus}
                />
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
