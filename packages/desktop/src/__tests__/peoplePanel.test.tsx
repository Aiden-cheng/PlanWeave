/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { PeoplePanel } from "../renderer/team/PeoplePanel";
import { parseCollaborationInvitationHandoff } from "../renderer/team/collaborationInvitationHandoff";
import type {
  PeopleDeviceRow,
  PeopleHostRow,
  PeopleInvitationRow,
  PeopleMemberRow,
  PeoplePresenceSummary
} from "../renderer/collaboration/peopleViewModels";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const t = createTranslator("en");

const presence: PeoplePresenceSummary = {
  memberCount: 2,
  hostCount: 1,
  onlineHostCount: 1,
  avatarMembers: [
    { humanPrincipalId: "human-1", displayName: "Owner", initials: "OW" },
    { humanPrincipalId: "human-2", displayName: "Member", initials: "ME" }
  ],
  sessionPhase: "connected",
  syncPhase: "ready",
  currentUserIsOwner: true,
  credentialPersistence: "persisted",
  nonPersistenceWarning: null
};

const members: PeopleMemberRow[] = [
  {
    membershipId: "m-1",
    humanPrincipalId: "human-1",
    displayName: "Owner",
    role: "owner",
    isCurrentUser: true,
    initials: "OW",
    actions: [
      { action: "promote", allowed: false, reason: "already_owner" },
      { action: "demote", allowed: false, reason: "last_owner" },
      { action: "remove", allowed: false, reason: "last_owner" }
    ]
  },
  {
    membershipId: "m-2",
    humanPrincipalId: "human-2",
    displayName: "Member",
    role: "member",
    isCurrentUser: false,
    initials: "ME",
    actions: [
      { action: "promote", allowed: true, reason: "ok" },
      { action: "demote", allowed: false, reason: "already_member" },
      { action: "remove", allowed: true, reason: "ok" }
    ]
  }
];

const hosts: PeopleHostRow[] = [
  {
    hostId: "host-1",
    displayName: "Builder",
    status: "online",
    capacityRemaining: 3,
    capabilities: ["shell", "git"],
    revoked: false,
    authorizedForProject: true,
    exists: true,
    versionSummary: null,
    lastSeenSummary: null
  }
];

const invitations: PeopleInvitationRow[] = [
  {
    invitationId: "inv-1",
    role: "member",
    createdAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-08T00:00:00.000Z",
    open: true
  }
];

const devices: PeopleDeviceRow[] = [
  {
    deviceCredentialId: "device-1",
    humanPrincipalId: "human-1",
    label: "Desktop",
    createdAt: "2030-01-01T00:00:00.000Z",
    lastSeenAt: "2030-01-02T00:00:00.000Z",
    isRevoked: false
  }
];

afterEach(() => {
  cleanupRendererTestEnvironment();
  vi.restoreAllMocks();
});

describe("PeoplePanel", () => {
  it("renders members and hosts separately and supports owner invite/copy-once", async () => {
    const onCreateInvitation = vi.fn().mockResolvedValue({
      invitation: {
        invitationId: "inv-new",
        projectId: "project-1",
        role: "member",
        createdByHumanPrincipalId: "human-1",
        createdAt: "2030-01-01T00:00:00.000Z",
        expiresAt: "2030-01-08T00:00:00.000Z"
      },
      invitationToken: `pw_inv_${"A".repeat(43)}`
    });
    const onCopy = vi.fn().mockResolvedValue(undefined);
    const onPromote = vi.fn().mockResolvedValue(true);
    const onRemove = vi.fn().mockResolvedValue(true);
    const onRevokeInvitation = vi.fn().mockResolvedValue(true);
    const onRevokeDevice = vi.fn().mockResolvedValue(true);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const { rerender } = render(
      <PeoplePanel
        mode="ready"
        presence={presence}
        members={members}
        hosts={hosts}
        invitations={invitations}
        devices={devices}
        detailsLoading={false}
        detailsError={null}
        actionError={null}
        actionBusy={false}
        pendingInvitation={null}
        t={t}
        onCreateInvitation={onCreateInvitation}
        onCopyInvitationToken={onCopy}
        onDismissPendingInvitation={vi.fn()}
        onRevokeInvitation={onRevokeInvitation}
        onRevokeInvitations={vi.fn()}
        onPromoteMember={onPromote}
        onDemoteMember={vi.fn()}
        onRemoveMember={onRemove}
        onRevokeDevice={onRevokeDevice}
        onRefreshDetails={vi.fn()}
      />
    );

    expect(screen.getByTestId("people-panel")).toHaveAttribute("data-mode", "ready");
    expect(screen.getByTestId("people-members-section")).toBeVisible();
    expect(screen.getByTestId("people-hosts-section")).toBeVisible();
    expect(screen.getByTestId("people-host-status")).toHaveAttribute("data-status", "online");
    expect(screen.getByTestId("people-host-version")).toHaveTextContent("not in projection");
    expect(screen.getByTestId("people-last-owner-guard")).toHaveTextContent("Last owner protected");

    await userEvent.click(screen.getByTestId("people-member-promote"));
    expect(onPromote).toHaveBeenCalledWith("human-2");

    await userEvent.click(screen.getByTestId("people-owner-toggle"));
    expect(screen.getByTestId("people-invitations-list")).toBeVisible();
    expect(screen.getByTestId("people-devices-list")).toBeVisible();

    await userEvent.click(screen.getByTestId("people-create-invitation"));
    expect(onCreateInvitation).toHaveBeenCalled();

    rerender(
      <PeoplePanel
        mode="ready"
        presence={presence}
        members={members}
        hosts={hosts}
        invitations={invitations}
        devices={devices}
        detailsLoading={false}
        detailsError={null}
        actionError={null}
        actionBusy={false}
        pendingInvitation={{
          invitation: {
            invitationId: "inv-new",
            projectId: "project-1",
            role: "member",
            createdByHumanPrincipalId: "human-1",
            createdAt: "2030-01-01T00:00:00.000Z",
            expiresAt: "2030-01-08T00:00:00.000Z"
          },
          invitationToken: `pw_inv_${"A".repeat(43)}`
        }}
        t={t}
        onCreateInvitation={onCreateInvitation}
        onCopyInvitationToken={onCopy}
        onDismissPendingInvitation={vi.fn()}
        onRevokeInvitation={onRevokeInvitation}
        onRevokeInvitations={vi.fn()}
        onPromoteMember={onPromote}
        onDemoteMember={vi.fn()}
        onRemoveMember={onRemove}
        onRevokeDevice={onRevokeDevice}
        onRefreshDetails={vi.fn()}
      />
    );

    const secret = screen.getByTestId("people-invitation-secret-once");
    expect(secret).toBeVisible();
    expect(within(secret).getByTestId("people-invitation-token-value")).toHaveValue(
      `pw_inv_${"A".repeat(43)}`
    );
    await userEvent.click(screen.getByTestId("people-invitation-copy"));
    expect(onCopy).toHaveBeenCalledWith(`pw_inv_${"A".repeat(43)}`);

    await userEvent.click(screen.getByTestId("people-invitation-revoke"));
    expect(onRevokeInvitation).toHaveBeenCalledWith("inv-1");
    await userEvent.click(screen.getByTestId("people-device-revoke"));
    expect(onRevokeDevice).toHaveBeenCalledWith("device-1");
  });

  it("shows the connect slot without surfacing disconnected API noise", () => {
    render(
      <PeoplePanel
        mode="disconnected"
        presence={{ ...presence, memberCount: 0, currentUserIsOwner: false }}
        members={[]}
        hosts={[]}
        invitations={[]}
        devices={[]}
        detailsLoading={false}
        detailsError={null}
        actionError={null}
        actionBusy={false}
        pendingInvitation={null}
        t={t}
        onCreateInvitation={vi.fn()}
        onCopyInvitationToken={vi.fn()}
        onDismissPendingInvitation={vi.fn()}
        onRevokeInvitation={vi.fn()}
        onRevokeInvitations={vi.fn()}
        onPromoteMember={vi.fn()}
        onDemoteMember={vi.fn()}
        onRemoveMember={vi.fn()}
        onRevokeDevice={vi.fn()}
        onRefreshDetails={vi.fn()}
        connectSlot={<div data-testid="people-connect-form">connect</div>}
      />
    );

    expect(screen.getByTestId("people-panel")).toHaveAttribute("data-mode", "disconnected");
    expect(screen.getByTestId("people-connect-form")).toBeVisible();
    expect(screen.queryByText(/Not connected/i)).not.toBeInTheDocument();
  });

  it("keeps an empty workspace neutral and keeps advanced recovery collapsed", async () => {
    const connectSlot = <div data-testid="people-connect-form">connect</div>;
    const commonProps = {
      presence: { ...presence, memberCount: 0, hostCount: 0, onlineHostCount: 0 },
      members: [],
      hosts: [],
      invitations: [],
      devices: [],
      detailsLoading: false,
      detailsError: null,
      actionError: null,
      actionBusy: false,
      pendingInvitation: null,
      t,
      onCreateInvitation: vi.fn(),
      onCopyInvitationToken: vi.fn(),
      onDismissPendingInvitation: vi.fn(),
      onRevokeInvitation: vi.fn(),
      onPromoteMember: vi.fn(),
      onDemoteMember: vi.fn(),
      onRemoveMember: vi.fn(),
      onRevokeDevice: vi.fn(),
      onRefreshDetails: vi.fn(),
      connectSlot
    };

    const { rerender } = render(<PeoplePanel {...commonProps} mode="empty" />);

    expect(screen.getByTestId("people-empty")).toHaveClass("text-muted-foreground");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    rerender(<PeoplePanel {...commonProps} mode="error" />);

    expect(screen.getByTestId("people-error")).toBeVisible();
    expect(screen.getByTestId("people-error")).toHaveClass("text-muted-foreground");
    expect(screen.getByTestId("people-error")).not.toHaveAttribute("role", "alert");
    expect(screen.queryByTestId("people-connect-form")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("people-toggle-connection-settings"));
    expect(screen.getByTestId("people-connect-form")).toBeVisible();
  });

  it("opens invitation management after a lone owner finishes initialization", () => {
    render(
      <PeoplePanel
        mode="ready"
        presence={{ ...presence, memberCount: 1, hostCount: 0, onlineHostCount: 0 }}
        members={[members[0]!]}
        hosts={[]}
        invitations={[]}
        devices={[]}
        detailsLoading={false}
        detailsError={null}
        actionError={null}
        actionBusy={false}
        pendingInvitation={null}
        t={t}
        onCreateInvitation={vi.fn()}
        onCopyInvitationToken={vi.fn()}
        onDismissPendingInvitation={vi.fn()}
        onRevokeInvitation={vi.fn()}
        onRevokeInvitations={vi.fn()}
        onPromoteMember={vi.fn()}
        onDemoteMember={vi.fn()}
        onRemoveMember={vi.fn()}
        onRevokeDevice={vi.fn()}
        onRefreshDetails={vi.fn()}
      />
    );

    expect(screen.getByTestId("people-owner-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("people-create-invitation")).toBeVisible();
  });

  it("copies a complete cross-device invitation handoff when connection details exist", async () => {
    const onCopy = vi.fn().mockResolvedValue(undefined);
    render(
      <PeoplePanel
        mode="ready"
        presence={presence}
        members={members}
        hosts={hosts}
        invitations={[]}
        devices={[]}
        detailsLoading={false}
        detailsError={null}
        actionError={null}
        actionBusy={false}
        pendingInvitation={{
          invitation: {
            invitationId: "inv-new",
            projectId: "project-1",
            role: "member",
            createdByHumanPrincipalId: "human-1",
            createdAt: "2030-01-01T00:00:00.000Z",
            expiresAt: "2030-01-08T00:00:00.000Z"
          },
          invitationToken: `pw_inv_${"A".repeat(43)}`
        }}
        invitationConnection={{
          serverBaseUrl: "http://192.168.1.20:56584/",
          projectId: "project-1"
        }}
        t={t}
        onCreateInvitation={vi.fn()}
        onCopyInvitationToken={onCopy}
        onDismissPendingInvitation={vi.fn()}
        onRevokeInvitation={vi.fn()}
        onRevokeInvitations={vi.fn()}
        onPromoteMember={vi.fn()}
        onDemoteMember={vi.fn()}
        onRemoveMember={vi.fn()}
        onRevokeDevice={vi.fn()}
        onRefreshDetails={vi.fn()}
      />
    );

    const visibleInvitation = screen.getByTestId("people-invitation-token-value");
    expect(screen.getByTestId("people-invitation-connection-summary")).toHaveTextContent(
      "http://192.168.1.20:56584/"
    );
    expect(visibleInvitation.value).toContain("planweave-collaboration-invitation/v1:");

    await userEvent.click(screen.getByTestId("people-invitation-copy"));

    const copiedInvitation = onCopy.mock.calls[0]?.[0];
    expect(copiedInvitation).toEqual(
      expect.stringContaining("planweave-collaboration-invitation/v1:")
    );
    expect(parseCollaborationInvitationHandoff(copiedInvitation ?? "")).toEqual({
      serverBaseUrl: "http://192.168.1.20:56584/",
      projectId: "project-1",
      invitationToken: `pw_inv_${"A".repeat(43)}`,
      allowInsecureTransport: true
    });
  });

  it("uses readable invitation and device summaries instead of raw identifiers", () => {
    const invitationId = "24e269e7-2c6a-43cc-995f-6e73db44fb1c";
    const deviceId = "369c6c7c-dace-4f0b-a8b9-16da98374eac";
    render(
      <PeoplePanel
        mode="ready"
        presence={presence}
        members={members}
        hosts={[]}
        invitations={[
          {
            invitationId,
            role: "member",
            createdAt: "2030-01-01T00:00:00.000Z",
            expiresAt: "2030-01-08T00:00:00.000Z",
            open: true
          }
        ]}
        devices={[
          {
            deviceCredentialId: deviceId,
            humanPrincipalId: "human-1",
            label: deviceId,
            createdAt: "2030-01-01T00:00:00.000Z",
            lastSeenAt: "2030-01-02T00:00:00.000Z",
            isRevoked: false
          }
        ]}
        detailsLoading={false}
        detailsError={null}
        actionError={null}
        actionBusy={false}
        pendingInvitation={null}
        t={t}
        onCreateInvitation={vi.fn()}
        onCopyInvitationToken={vi.fn()}
        onDismissPendingInvitation={vi.fn()}
        onRevokeInvitation={vi.fn()}
        onRevokeInvitations={vi.fn()}
        onPromoteMember={vi.fn()}
        onDemoteMember={vi.fn()}
        onRemoveMember={vi.fn()}
        onRevokeDevice={vi.fn()}
        onRefreshDetails={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId("people-owner-toggle"));

    expect(screen.getByTestId("people-invitation-row")).toHaveTextContent("Waiting for a member");
    expect(screen.getByTestId("people-invitation-row")).toHaveTextContent(
      "Invite ID 24e269e7…fb1c"
    );
    expect(screen.getByTestId("people-device-row")).toHaveTextContent("Unnamed device 1");
    expect(screen.getByTestId("people-device-row")).toHaveTextContent("Member: Owner");
    expect(screen.getByTestId("people-device-row")).toHaveTextContent("Device ID 369c6c7c…4eac");
    expect(screen.queryByText(invitationId)).not.toBeInTheDocument();
    expect(screen.queryByText(deviceId)).not.toBeInTheDocument();
  });

  it("selects and revokes multiple open invitations in one action", async () => {
    const onRevokeInvitations = vi.fn().mockResolvedValue(true);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <PeoplePanel
        mode="ready"
        presence={presence}
        members={members}
        hosts={[]}
        invitations={[
          { ...invitations[0]!, invitationId: "inv-1" },
          { ...invitations[0]!, invitationId: "inv-2" },
          {
            ...invitations[0]!,
            invitationId: "inv-closed",
            open: false,
            revokedAt: "2030-01-02T00:00:00.000Z"
          }
        ]}
        devices={[]}
        detailsLoading={false}
        detailsError={null}
        actionError={null}
        actionBusy={false}
        pendingInvitation={null}
        t={t}
        onCreateInvitation={vi.fn()}
        onCopyInvitationToken={vi.fn()}
        onDismissPendingInvitation={vi.fn()}
        onRevokeInvitation={vi.fn()}
        onRevokeInvitations={onRevokeInvitations}
        onPromoteMember={vi.fn()}
        onDemoteMember={vi.fn()}
        onRemoveMember={vi.fn()}
        onRevokeDevice={vi.fn()}
        onRefreshDetails={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId("people-owner-toggle"));
    await userEvent.click(screen.getByTestId("people-invitation-select-all"));

    expect(screen.getByTestId("people-invitation-revoke-selected")).toHaveTextContent(
      "Revoke selected (2)"
    );
    await userEvent.click(screen.getByTestId("people-invitation-revoke-selected"));

    expect(window.confirm).toHaveBeenCalledWith(
      "Revoke the 2 selected invitations? This action cannot be undone."
    );
    expect(onRevokeInvitations).toHaveBeenCalledWith(["inv-1", "inv-2"]);
  });

  it("shows forbidden state without owner mutation controls", () => {
    render(
      <PeoplePanel
        mode="forbidden"
        presence={{ ...presence, currentUserIsOwner: false }}
        members={members}
        hosts={hosts}
        invitations={[]}
        devices={[]}
        detailsLoading={false}
        detailsError={null}
        actionError="human_forbidden: not allowed"
        actionBusy={false}
        pendingInvitation={null}
        t={t}
        onCreateInvitation={vi.fn()}
        onCopyInvitationToken={vi.fn()}
        onDismissPendingInvitation={vi.fn()}
        onRevokeInvitation={vi.fn()}
        onRevokeInvitations={vi.fn()}
        onPromoteMember={vi.fn()}
        onDemoteMember={vi.fn()}
        onRemoveMember={vi.fn()}
        onRevokeDevice={vi.fn()}
        onRefreshDetails={vi.fn()}
      />
    );

    expect(screen.getByTestId("people-panel-auth-error")).toHaveTextContent(/permission/i);
    expect(screen.queryByTestId("people-owner-section")).not.toBeInTheDocument();
  });
});
