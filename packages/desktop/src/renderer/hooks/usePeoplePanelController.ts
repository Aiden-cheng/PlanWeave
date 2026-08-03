import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  HumanDeviceView,
  HumanInvitationView,
  HumanMembershipView
} from "@planweave-ai/collaboration-protocol/identity/workspace";
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
  CollaborationInvitationHandoffView,
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
  /** Renderer-owned localization for typed boundary errors. */
  formatError?: (error: unknown) => string;
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
  pendingInvitation: CollaborationInvitationHandoffView | null;
  clearPendingInvitation: () => void;
  clearActionError: () => void;
  refreshDetails: () => Promise<void>;
  createInvitation: () => Promise<CollaborationInvitationHandoffView | null>;
  viewInvitation: (invitationId: string) => Promise<CollaborationInvitationHandoffView | null>;
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
    useState<CollaborationInvitationHandoffView | null>(null);
  const detailsGenerationRef = useRef(0);
  const detailsRequestRef = useRef<Promise<void> | null>(null);
  const detailsRequestProfileRef = useRef<string | null>(null);
  const sessionConnected = isCollaborationSessionConnected(args.status);
  const activeProfileId = args.status?.activeProfileId ?? null;
  const formatError = args.formatError ?? collaborationErrorMessage;

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

  const refreshDetails = useCallback((): Promise<void> => {
    if (!api || !sessionConnected || !activeProfileId || !currentUserIsOwner) {
      detailsGenerationRef.current += 1;
      detailsRequestRef.current = null;
      detailsRequestProfileRef.current = null;
      setInvitations([]);
      setDevices([]);
      setDetailsLoading(false);
      setDetailsError(null);
      return Promise.resolve();
    }
    if (detailsRequestRef.current && detailsRequestProfileRef.current === activeProfileId) {
      return detailsRequestRef.current;
    }
    const generation = detailsGenerationRef.current + 1;
    detailsGenerationRef.current = generation;
    detailsRequestProfileRef.current = activeProfileId;
    setDetailsLoading(true);
    setDetailsError(null);
    const request = (async () => {
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
        setDetailsError(formatError(error));
      } finally {
        if (detailsGenerationRef.current === generation) {
          setDetailsLoading(false);
        }
      }
    })();
    detailsRequestRef.current = request;
    void request.finally(() => {
      if (detailsRequestRef.current === request) {
        detailsRequestRef.current = null;
        detailsRequestProfileRef.current = null;
      }
    });
    return request;
  }, [activeProfileId, api, currentUserIsOwner, formatError, sessionConnected]);

  useEffect(() => {
    if (!args.detailsOpen) return;
    void refreshDetails();
  }, [args.detailsOpen, refreshDetails]);

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
        setActionError(formatError(error));
        return false;
      } finally {
        setActionBusy(false);
      }
    },
    [actionBusy, api, formatError, refreshDetails, sessionConnected]
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
        const created = await api.createCollaborationInvitationHandoff({
          idempotencyKey: globalThis.crypto.randomUUID()
        });
        setPendingInvitation(created);
        setInvitations((current) => [
          ...current.filter(
            (invitation) => invitation.invitationId !== created.invitation.invitationId
          ),
          created.invitation
        ]);
        await refreshDetails();
        return created;
      } catch (error) {
        setActionError(formatError(error));
        return null;
      } finally {
        setActionBusy(false);
      }
    },
    viewInvitation: async (invitationId) => {
      if (!api || !sessionConnected || actionBusy) return null;
      setActionBusy(true);
      setActionError(null);
      try {
        const invitation = await api.getCollaborationInvitationHandoff({ invitationId });
        setPendingInvitation(invitation);
        return invitation;
      } catch (error) {
        setActionError(formatError(error));
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
            current.filter((invitation) => invitation.invitationId !== revoked.invitationId)
          );
          setPendingInvitation((current) =>
            current?.invitation.invitationId === revoked.invitationId ? null : current
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
          const revokedIds = new Set(revoked.items.map((invitation) => invitation.invitationId));
          setInvitations((current) =>
            current.filter((invitation) => !revokedIds.has(invitation.invitationId))
          );
          setPendingInvitation((current) =>
            current && revokedIds.has(current.invitation.invitationId) ? null : current
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
