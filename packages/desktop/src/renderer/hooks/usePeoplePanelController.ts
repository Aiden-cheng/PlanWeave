import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  HumanDeviceView,
  HumanInvitationView,
  HumanMembershipView
} from "@planweave-ai/collaboration-contracts";
import { collaborationBridge } from "../bridge";
import { collaborationErrorMessage } from "../collaboration/formatCollaborationError";
import {
  buildPeopleDeviceRows,
  buildPeopleHostRows,
  buildPeopleInvitationRows,
  buildPeopleMemberRows,
  buildPeoplePresenceSummary,
  resolveCurrentMembership,
  resolvePeoplePanelMode,
  type PeopleDeviceRow,
  type PeopleHostRow,
  type PeopleInvitationRow,
  type PeopleMemberRow,
  type PeoplePanelMode,
  type PeoplePresenceSummary
} from "../collaboration/peopleViewModels";
import type {
  CollaborationInvitationCreateView,
  CollaborationStatus,
  PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";
import { collaborationInvitationIdsInputSchema } from "../../shared/collaboration.js";
import type {
  CollaborationHostProjection,
  CollaborationSyncPhase
} from "../../shared/collaborationReadModels.js";
import { isCollaborationSessionConnected } from "../collaboration/sessionState";

export type UsePeoplePanelControllerArgs = {
  api?: PlanWeaveCollaborationApi | null;
  status: CollaborationStatus | null;
  members: readonly HumanMembershipView[];
  hosts: readonly CollaborationHostProjection[];
  syncPhase: CollaborationSyncPhase;
  /** When true, load invitations/devices (on-demand detailed panel). */
  detailsOpen: boolean;
};

export type UsePeoplePanelControllerResult = {
  mode: PeoplePanelMode;
  presence: PeoplePresenceSummary;
  members: PeopleMemberRow[];
  hosts: PeopleHostRow[];
  invitations: PeopleInvitationRow[];
  devices: PeopleDeviceRow[];
  detailsLoading: boolean;
  detailsError: string | null;
  actionError: string | null;
  actionBusy: boolean;
  pendingInvitation: CollaborationInvitationCreateView | null;
  clearPendingInvitation: () => void;
  clearActionError: () => void;
  refreshDetails: () => Promise<void>;
  createInvitation: () => Promise<CollaborationInvitationCreateView | null>;
  revokeInvitation: (invitationId: string) => Promise<boolean>;
  revokeInvitations: (invitationIds: readonly string[]) => Promise<boolean>;
  promoteMember: (humanPrincipalId: string) => Promise<boolean>;
  demoteMember: (humanPrincipalId: string) => Promise<boolean>;
  removeMember: (humanPrincipalId: string) => Promise<boolean>;
  revokeDevice: (deviceCredentialId: string) => Promise<boolean>;
};

export function usePeoplePanelController(
  args: UsePeoplePanelControllerArgs
): UsePeoplePanelControllerResult {
  const api = args.api === undefined ? collaborationBridge : args.api;
  const [invitations, setInvitations] = useState<HumanInvitationView[]>([]);
  const [devices, setDevices] = useState<HumanDeviceView[]>([]);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [pendingInvitation, setPendingInvitation] =
    useState<CollaborationInvitationCreateView | null>(null);
  const detailsGenerationRef = useRef(0);
  const sessionConnected = isCollaborationSessionConnected(args.status);

  const currentMembership = useMemo(
    () =>
      resolveCurrentMembership({
        members: args.members,
        status: args.status
      }),
    [args.members, args.status]
  );
  const currentHumanPrincipalId = currentMembership?.humanPrincipalId ?? null;
  const currentUserIsOwner = currentMembership?.role === "owner";

  const presence = useMemo(
    () =>
      buildPeoplePresenceSummary({
        members: args.members,
        hosts: args.hosts,
        status: args.status,
        syncPhase: args.syncPhase
      }),
    [args.hosts, args.members, args.status, args.syncPhase]
  );

  const mode = useMemo(
    () =>
      resolvePeoplePanelMode({
        status: args.status,
        syncPhase: args.syncPhase,
        memberCount: args.members.length
      }),
    [args.members.length, args.status, args.syncPhase]
  );

  const memberRows = useMemo(
    () =>
      buildPeopleMemberRows({
        members: args.members,
        currentHumanPrincipalId,
        currentUserIsOwner
      }),
    [args.members, currentHumanPrincipalId, currentUserIsOwner]
  );

  const hostRows = useMemo(() => buildPeopleHostRows(args.hosts), [args.hosts]);
  const invitationRows = useMemo(() => buildPeopleInvitationRows(invitations), [invitations]);
  const deviceRows = useMemo(() => buildPeopleDeviceRows(devices), [devices]);

  const refreshDetails = useCallback(async () => {
    if (!api || !sessionConnected) {
      setInvitations([]);
      setDevices([]);
      return;
    }
    const generation = detailsGenerationRef.current + 1;
    detailsGenerationRef.current = generation;
    setDetailsLoading(true);
    setDetailsError(null);
    try {
      const [invitationPage, devicePage] = await Promise.all([
        api.listCollaborationInvitations({ cursor: 0, limit: 100, openOnly: true }),
        api.listCollaborationDevices({ cursor: 0, limit: 50, scope: "project" })
      ]);
      if (detailsGenerationRef.current !== generation) {
        return;
      }
      setInvitations(
        [...invitationPage.items].sort((left, right) =>
          left.createdAt.localeCompare(right.createdAt)
        )
      );
      setDevices(devicePage.items);
    } catch (error) {
      if (detailsGenerationRef.current !== generation) {
        return;
      }
      setDetailsError(collaborationErrorMessage(error));
      setInvitations([]);
      setDevices([]);
    } finally {
      if (detailsGenerationRef.current === generation) {
        setDetailsLoading(false);
      }
    }
  }, [api, sessionConnected]);

  useEffect(() => {
    if (!args.detailsOpen || !sessionConnected) {
      return;
    }
    if (
      mode === "disconnected" ||
      mode === "connecting" ||
      mode === "auth_expired" ||
      mode === "forbidden"
    ) {
      return;
    }
    void refreshDetails();
  }, [args.detailsOpen, mode, refreshDetails, sessionConnected]);

  const runAction = useCallback(
    async (operation: () => Promise<void>, options?: { refreshDetails?: boolean }) => {
      if (!api || !sessionConnected || actionBusy) return false;
      setActionBusy(true);
      setActionError(null);
      try {
        await operation();
        if (options?.refreshDetails !== false) {
          await refreshDetails();
        }
        return true;
      } catch (error) {
        setActionError(collaborationErrorMessage(error));
        return false;
      } finally {
        setActionBusy(false);
      }
    },
    [actionBusy, api, refreshDetails, sessionConnected]
  );

  return {
    mode,
    presence,
    members: memberRows,
    hosts: hostRows,
    invitations: invitationRows,
    devices: deviceRows,
    detailsLoading,
    detailsError,
    actionError,
    actionBusy,
    pendingInvitation,
    clearPendingInvitation: () => setPendingInvitation(null),
    clearActionError: () => setActionError(null),
    refreshDetails,
    createInvitation: async () => {
      if (!api || !sessionConnected || actionBusy) return null;
      setActionBusy(true);
      setActionError(null);
      try {
        const created = await api.createCollaborationInvitation({});
        setPendingInvitation(created);
        await refreshDetails();
        return created;
      } catch (error) {
        setActionError(collaborationErrorMessage(error));
        return null;
      } finally {
        setActionBusy(false);
      }
    },
    revokeInvitation: async (invitationId) =>
      runAction(
        async () => {
          const revoked = await api!.revokeCollaborationInvitation({ invitationId });
          setInvitations((current) =>
            current.map((invitation) =>
              invitation.invitationId === revoked.invitationId ? revoked : invitation
            )
          );
        },
        { refreshDetails: false }
      ),
    revokeInvitations: async (invitationIds) =>
      runAction(
        async () => {
          const input = collaborationInvitationIdsInputSchema.parse({
            invitationIds: [...invitationIds]
          });
          const revoked = await api!.revokeCollaborationInvitations(input);
          const revokedById = new Map(
            revoked.items.map((invitation) => [invitation.invitationId, invitation])
          );
          setInvitations((current) =>
            current.map((invitation) => revokedById.get(invitation.invitationId) ?? invitation)
          );
        },
        { refreshDetails: false }
      ),
    promoteMember: async (humanPrincipalId) =>
      runAction(
        async () => {
          await api!.promoteCollaborationOwner({ humanPrincipalId });
        },
        { refreshDetails: false }
      ),
    demoteMember: async (humanPrincipalId) =>
      runAction(
        async () => {
          await api!.demoteCollaborationOwner({ humanPrincipalId });
        },
        { refreshDetails: false }
      ),
    removeMember: async (humanPrincipalId) =>
      runAction(
        async () => {
          await api!.removeCollaborationMember({ humanPrincipalId });
        },
        { refreshDetails: false }
      ),
    revokeDevice: async (deviceCredentialId) =>
      runAction(async () => {
        await api!.revokeCollaborationDevice({ deviceCredentialId });
      })
  };
}
