import { useMemo, useRef, useState } from "react";
import { UsersIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from "@/components/ui/popover";
import type { createTranslator } from "../i18n";
import { collaborationBridge } from "../bridge";
import { useCollaborationStatus } from "../hooks/useCollaborationStatus";
import { useCollaborationReadModels } from "../hooks/useCollaborationReadModels";
import { usePeoplePanelController } from "../hooks/usePeoplePanelController";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import { CollaborationConnectForm } from "./CollaborationConnectForm";
import { PeoplePanel } from "./PeoplePanel";

export type PeoplePresenceControlProps = {
  t: ReturnType<typeof createTranslator>;
  /** Injected API for tests. */
  api?: PlanWeaveCollaborationApi | null;
  /** Optional clipboard writer; defaults to navigator.clipboard. */
  copyText?: (text: string) => Promise<void>;
  className?: string;
};

async function defaultCopyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error("clipboard_unavailable");
}

/**
 * Compact active-project people entry for shell/header/sidebar.
 * Detailed invitation/device lists load only when the popover is open.
 */
export function PeoplePresenceControl({
  t,
  api: apiProp,
  copyText = defaultCopyText,
  className
}: PeoplePresenceControlProps) {
  const api = apiProp === undefined ? collaborationBridge : apiProp;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const { status } = useCollaborationStatus({ api });

  const activeProfile = useMemo(() => {
    if (!status?.activeProfileId) return null;
    return status.profiles.find((profile) => profile.profileId === status.activeProfileId) ?? null;
  }, [status]);

  const sessionConnected =
    status?.session.phase === "connected" || status?.session.phase === "ready";

  // Stable port identity — avoid recreating CollaborationReadModelController each render.
  const readApi = useMemo(
    () =>
      api
        ? {
            getCollaborationStatus: () => api.getCollaborationStatus(),
            listCollaborationMembers: (input?: Parameters<
              PlanWeaveCollaborationApi["listCollaborationMembers"]
            >[0]) => api.listCollaborationMembers(input),
            listCollaborationAssignments: (input?: Parameters<
              PlanWeaveCollaborationApi["listCollaborationAssignments"]
            >[0]) => api.listCollaborationAssignments(input),
            listCollaborationEligibleAssignees: (
              input: Parameters<PlanWeaveCollaborationApi["listCollaborationEligibleAssignees"]>[0]
            ) => api.listCollaborationEligibleAssignees(input),
            listCollaborationComments: (
              input: Parameters<PlanWeaveCollaborationApi["listCollaborationComments"]>[0]
            ) => api.listCollaborationComments(input),
            listCollaborationActivity: (input?: Parameters<
              PlanWeaveCollaborationApi["listCollaborationActivity"]
            >[0]) => api.listCollaborationActivity(input),
            updateCollaborationAssignment: (
              input: Parameters<PlanWeaveCollaborationApi["updateCollaborationAssignment"]>[0]
            ) => api.updateCollaborationAssignment(input),
            createCollaborationComment: (
              input: Parameters<PlanWeaveCollaborationApi["createCollaborationComment"]>[0]
            ) => api.createCollaborationComment(input),
            editCollaborationComment: (
              input: Parameters<PlanWeaveCollaborationApi["editCollaborationComment"]>[0]
            ) => api.editCollaborationComment(input),
            tombstoneCollaborationComment: (
              input: Parameters<PlanWeaveCollaborationApi["tombstoneCollaborationComment"]>[0]
            ) => api.tombstoneCollaborationComment(input),
            onCollaborationStatusChanged: (
              callback: Parameters<PlanWeaveCollaborationApi["onCollaborationStatusChanged"]>[0]
            ) => api.onCollaborationStatusChanged(callback),
            onCollaborationObserverSignal: (
              callback: Parameters<PlanWeaveCollaborationApi["onCollaborationObserverSignal"]>[0]
            ) => api.onCollaborationObserverSignal(callback)
          }
        : null,
    [api]
  );

  const { snapshot, viewModel, controller } = useCollaborationReadModels({
    api: readApi,
    profileId: sessionConnected ? (activeProfile?.profileId ?? null) : null,
    projectId: sessionConnected ? (activeProfile?.projectId ?? null) : null
  });

  const panel = usePeoplePanelController({
    api,
    status,
    members: viewModel.members,
    hosts: viewModel.hosts,
    syncPhase: snapshot.syncPhase,
    detailsOpen: open
  });

  const refreshMembers = async () => {
    if (controller && activeProfile) {
      await controller.refreshAuthoritative({ reason: "people_member_mutation" });
    }
  };

  const triggerLabel =
    panel.presence.memberCount > 0
      ? t("peoplePresenceWithCount").replace("{count}", String(panel.presence.memberCount))
      : t("peoplePresence");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          size="sm"
          variant="ghost"
          className={className}
          data-testid="people-presence-trigger"
          aria-label={triggerLabel}
          title={triggerLabel}
        >
          <span className="flex items-center gap-1">
            {panel.presence.avatarMembers.length > 0 ? (
              <span className="flex -space-x-1.5" data-testid="people-presence-avatars" aria-hidden="true">
                {panel.presence.avatarMembers.slice(0, 3).map((member) => (
                  <span
                    key={member.humanPrincipalId}
                    className="inline-flex size-5 items-center justify-center rounded-full bg-state-selected-surface text-[9px] font-semibold text-text-strong ring-1 ring-background"
                  >
                    {member.initials}
                  </span>
                ))}
              </span>
            ) : (
              <UsersIcon className="size-4" data-icon="inline-start" />
            )}
            <span className="text-xs">{t("people")}</span>
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[360px] p-3"
        data-testid="people-presence-popover"
        onCloseAutoFocus={(event) => {
          // Focus restoration only — not business state.
          event.preventDefault();
          triggerRef.current?.focus();
        }}
      >
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
          t={t}
          onCreateInvitation={panel.createInvitation}
          onCopyInvitationToken={copyText}
          onDismissPendingInvitation={panel.clearPendingInvitation}
          onRevokeInvitation={panel.revokeInvitation}
          onPromoteMember={async (humanPrincipalId) => {
            const ok = await panel.promoteMember(humanPrincipalId);
            if (ok) await refreshMembers();
            return ok;
          }}
          onDemoteMember={async (humanPrincipalId) => {
            const ok = await panel.demoteMember(humanPrincipalId);
            if (ok) await refreshMembers();
            return ok;
          }}
          onRemoveMember={async (humanPrincipalId) => {
            const ok = await panel.removeMember(humanPrincipalId);
            if (ok) await refreshMembers();
            return ok;
          }}
          onRevokeDevice={panel.revokeDevice}
          onRefreshDetails={async () => {
            await panel.refreshDetails();
            await refreshMembers();
          }}
          connectSlot={
            <CollaborationConnectForm
              api={api}
              status={status}
              t={t}
              onConnected={() => {
                // Keep popover open so members can load after connect.
              }}
              onRequestClose={() => setOpen(false)}
            />
          }
        />
      </PopoverContent>
    </Popover>
  );
}
