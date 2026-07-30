import { useMemo } from "react";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import { collaborationBridge } from "../bridge";
import type { createTranslator } from "../i18n";
import { useCollaborationReadModels } from "../hooks/useCollaborationReadModels";
import { useCollaborationStatus } from "../hooks/useCollaborationStatus";
import { usePeoplePanelController } from "../hooks/usePeoplePanelController";
import { CollaborationConnectForm } from "../team/CollaborationConnectForm";
import { PeoplePanel } from "../team/PeoplePanel";
import { ContentAuthorityPanel } from "../collaboration/ContentAuthorityPanel";
import { CurrentCanvasAccessPanel } from "../collaboration/CurrentCanvasAccessPanel";
import { LocalCollaborationServerPanel } from "../collaboration/LocalCollaborationServerPanel";
import { useCurrentCanvasAccess } from "../hooks/useCurrentCanvasAccess";
import { isCollaborationSessionConnected } from "../collaboration/sessionState";
import type { DesktopUiSettings } from "../types";

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
  const { status } = useCollaborationStatus({ api });

  const activeProfile = useMemo(() => {
    if (!status?.activeProfileId) return null;
    return status.profiles.find((profile) => profile.profileId === status.activeProfileId) ?? null;
  }, [status]);

  const sessionConnected = isCollaborationSessionConnected(status);
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
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 pb-8">
        <LocalCollaborationServerPanel
          key={`${activeProfile?.profileId ?? "local"}:${canvasId ?? "none"}`}
          api={api}
          t={t}
          projectId={activeProfile?.projectId ?? null}
          canvasId={canvasId}
          scopeLayout={collaborationScopeLayout}
          onScopeLayoutChange={onCollaborationScopeLayoutChange}
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
          connectSlot={<CollaborationConnectForm api={api} status={status} t={t} />}
        />
        <ContentAuthorityPanel
          api={api ?? null}
          canvasId={canvasId}
          connected={sessionConnected}
          t={t}
        />
      </div>
    </section>
  );
}
