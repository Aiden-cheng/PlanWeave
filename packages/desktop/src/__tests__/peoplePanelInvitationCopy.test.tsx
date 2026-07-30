/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { PeoplePanel, type PeoplePanelProps } from "../renderer/team/PeoplePanel";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const invitationToken = `pw_inv_${"A".repeat(43)}`;
const t = createTranslator("en");

function pendingInvitation(invitationId: string, token: string) {
  return {
    invitation: {
      invitationId,
      projectId: "project-1",
      role: "member" as const,
      createdByHumanPrincipalId: "human-1",
      createdAt: "2030-01-01T00:00:00.000Z",
      expiresAt: "2030-01-08T00:00:00.000Z"
    },
    invitationToken: token
  };
}

function createProps(
  pendingInvitationValue: PeoplePanelProps["pendingInvitation"],
  onCopyInvitationToken: PeoplePanelProps["onCopyInvitationToken"]
): PeoplePanelProps {
  return {
    mode: "ready",
    presence: {
      memberCount: 1,
      hostCount: 0,
      onlineHostCount: 0,
      avatarMembers: [],
      sessionPhase: "connected",
      syncPhase: "ready",
      currentUserIsOwner: true,
      credentialPersistence: "persisted",
      nonPersistenceWarning: null
    },
    members: [],
    hosts: [],
    invitations: [],
    devices: [],
    detailsLoading: false,
    detailsError: null,
    actionError: null,
    actionBusy: false,
    pendingInvitation: pendingInvitationValue,
    invitationConnection: {
      serverBaseUrl: "http://192.168.1.20:56584/",
      projectId: "project-1"
    },
    t,
    onCreateInvitation: vi.fn(),
    onCopyInvitationToken,
    onDismissPendingInvitation: vi.fn(),
    onRevokeInvitation: vi.fn(),
    onPromoteMember: vi.fn(),
    onDemoteMember: vi.fn(),
    onRemoveMember: vi.fn(),
    onRevokeDevice: vi.fn(),
    onRefreshDetails: vi.fn()
  };
}

afterEach(() => {
  cleanupRendererTestEnvironment();
  vi.restoreAllMocks();
});

describe("PeoplePanel invitation copy", () => {
  it("shows a localized clipboard error and resets copy feedback for each pending invitation", async () => {
    const onCopyInvitationToken = vi
      .fn<PeoplePanelProps["onCopyInvitationToken"]>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("clipboard_denied"));
    const first = pendingInvitation("inv-first", invitationToken);
    const second = pendingInvitation("inv-second", `pw_inv_${"B".repeat(43)}`);
    const third = pendingInvitation("inv-third", `pw_inv_${"C".repeat(43)}`);
    const { rerender } = render(
      <PeoplePanel {...createProps(first, onCopyInvitationToken)} />
    );

    await userEvent.click(screen.getByTestId("people-invitation-copy"));
    expect(screen.getByTestId("people-invitation-copy")).toHaveTextContent("Copied");

    rerender(<PeoplePanel {...createProps(second, onCopyInvitationToken)} />);
    expect(screen.getByTestId("people-invitation-copy")).toHaveTextContent(
      "Copy complete join details"
    );
    expect(screen.queryByTestId("people-invitation-copy-error")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("people-invitation-copy"));
    expect(await screen.findByTestId("people-invitation-copy-error")).toHaveTextContent(
      "Could not copy the invitation. Try again."
    );
    expect(screen.getByTestId("people-invitation-copy")).toHaveTextContent(
      "Copy complete join details"
    );

    rerender(<PeoplePanel {...createProps(third, onCopyInvitationToken)} />);
    expect(screen.queryByTestId("people-invitation-copy-error")).not.toBeInTheDocument();
  });
});
