/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { serializeCollaborationSetupHandoffV1 } from "@planweave-ai/collaboration-contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { CollaborationConnectForm } from "../renderer/team/CollaborationConnectForm";
import { serializeCollaborationInvitationHandoff } from "../renderer/team/collaborationInvitationHandoff";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

function joinApi() {
  return {
    upsertCollaborationProfile: vi.fn().mockResolvedValue(undefined),
    consumeCollaborationInvitation: vi.fn().mockResolvedValue({
      deviceCredentialPersistence: "persisted",
      nonPersistenceWarning: null
    }),
    connectCollaborationSession: vi.fn().mockResolvedValue(undefined)
  } as unknown as PlanWeaveCollaborationApi;
}

function setupApi() {
  return {
    redeemCollaborationSetupCode: vi.fn().mockResolvedValue(undefined)
  } as unknown as PlanWeaveCollaborationApi;
}

describe("CollaborationConnectForm Server setup onboarding", () => {
  it("redeems one complete setup handoff without exposing manual fields", async () => {
    const user = userEvent.setup();
    const api = setupApi();
    const handoff = serializeCollaborationSetupHandoffV1({
      serverBaseUrl: "http://192.168.1.20:56584/",
      setupCode: `pw_setup_${"A".repeat(43)}`,
      allowInsecureTransport: true
    });

    render(
      <CollaborationConnectForm
        api={api}
        status={null}
        t={createTranslator("en")}
        fixedMode="setup"
        showHeader={false}
        showConnectionSummary={false}
      />
    );

    expect(screen.queryByTestId("people-connect-server-url")).not.toBeInTheDocument();
    expect(screen.queryByTestId("people-connect-setup-code")).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("people-connect-setup-details"), {
      target: { value: handoff }
    });
    await user.click(screen.getByTestId("people-connect-submit"));

    await waitFor(() =>
      expect(api.redeemCollaborationSetupCode).toHaveBeenCalledWith({
        serverBaseUrl: "http://192.168.1.20:56584/",
        setupCode: `pw_setup_${"A".repeat(43)}`,
        allowInsecureTransport: true,
        displayName: "Collaboration"
      })
    );
    expect(screen.getByTestId("people-connect-setup-details")).toHaveValue("");
  });

  it("keeps the previous fields behind an explicit manual disclosure", async () => {
    const user = userEvent.setup();

    render(
      <CollaborationConnectForm
        api={setupApi()}
        status={null}
        t={createTranslator("en")}
        fixedMode="setup"
        showHeader={false}
        showConnectionSummary={false}
      />
    );

    await user.click(screen.getByTestId("people-connect-setup-manual-toggle"));

    expect(screen.getByTestId("people-connect-display-name")).toBeInTheDocument();
    expect(screen.getByTestId("people-connect-server-url")).toBeInTheDocument();
    expect(screen.getByTestId("people-connect-setup-code")).toBeInTheDocument();
  });

  it("rejects malformed complete setup details before invoking the bridge", async () => {
    const user = userEvent.setup();
    const api = setupApi();

    render(
      <CollaborationConnectForm
        api={api}
        status={null}
        t={createTranslator("en")}
        fixedMode="setup"
        showHeader={false}
        showConnectionSummary={false}
      />
    );

    await user.type(screen.getByTestId("people-connect-setup-details"), "not setup details");
    await user.click(screen.getByTestId("people-connect-submit"));

    expect(await screen.findByTestId("people-connect-error")).toHaveTextContent(
      "These Server connection details are incomplete or invalid"
    );
    expect(api.redeemCollaborationSetupCode).not.toHaveBeenCalled();
  });
});

describe("CollaborationConnectForm invitation onboarding", () => {
  it("joins from one complete invitation without exposing manual connection fields", async () => {
    const user = userEvent.setup();
    const api = joinApi();
    const invitationToken = `pw_inv_${"A".repeat(43)}`;
    const handoff = serializeCollaborationInvitationHandoff({
      serverBaseUrl: "http://192.168.1.20:56584",
      projectId: "project-1",
      invitationToken,
      allowInsecureTransport: true
    });

    render(
      <CollaborationConnectForm
        api={api}
        status={null}
        t={createTranslator("en")}
        fixedMode="join"
        showHeader={false}
        showConnectionSummary={false}
      />
    );

    expect(screen.getByLabelText("Your name or nickname")).toBeInTheDocument();

    expect(screen.queryByTestId("people-connect-server-url")).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("people-connect-invitation-details"), {
      target: { value: handoff }
    });
    await user.type(screen.getByTestId("people-connect-display-name"), "Windows member");
    await user.click(screen.getByTestId("people-connect-submit"));

    await waitFor(() =>
      expect(api.upsertCollaborationProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          displayName: "Windows member",
          serverBaseUrl: "http://192.168.1.20:56584",
          projectId: "project-1",
          allowInsecureTransport: true
        })
      )
    );
    expect(api.consumeCollaborationInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        request: { invitationToken, displayName: "Windows member" }
      })
    );
    expect(api.connectCollaborationSession).toHaveBeenCalledTimes(1);
  });

  it("creates a separate member profile and waits for the connected workspace refresh", async () => {
    const user = userEvent.setup();
    const api = joinApi();
    const onConnected = vi.fn().mockResolvedValue(undefined);
    const invitationToken = `pw_inv_${"B".repeat(43)}`;
    const handoff = serializeCollaborationInvitationHandoff({
      serverBaseUrl: "http://192.168.1.20:56584",
      projectId: "shared-project",
      invitationToken,
      allowInsecureTransport: true
    });

    render(
      <CollaborationConnectForm
        api={api}
        status={{
          activeProfileId: "existing-project-profile",
          profiles: [
            {
              profileId: "existing-project-profile",
              displayName: "Existing project",
              serverBaseUrl: "https://server.example",
              projectId: "existing-project",
              allowInsecureTransport: false,
              hasDeviceCredential: true
            }
          ],
          session: null,
          workspaceConnection: { status: "local_only" },
          workspacePicker: { items: [] },
          credentialStorage: "available",
          nonPersistenceWarning: null
        }}
        t={createTranslator("en")}
        fixedMode="join"
        showHeader={false}
        showConnectionSummary={false}
        onConnected={onConnected}
      />
    );

    fireEvent.change(screen.getByTestId("people-connect-invitation-details"), {
      target: { value: handoff }
    });
    await user.type(screen.getByTestId("people-connect-display-name"), "Windows member");
    await user.click(screen.getByTestId("people-connect-submit"));

    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    const profileInput = vi.mocked(api.upsertCollaborationProfile).mock.calls[0]?.[0];
    expect(profileInput?.profileId).toBeTruthy();
    expect(profileInput?.profileId).not.toBe("existing-project-profile");
    expect(api.consumeCollaborationInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: profileInput?.profileId })
    );
    expect(api.connectCollaborationSession).toHaveBeenCalledWith({
      profileId: profileInput?.profileId
    });
    expect(api.connectCollaborationSession.mock.invocationCallOrder[0]).toBeLessThan(
      onConnected.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it("keeps malformed invitation details out of the profile bridge", async () => {
    const user = userEvent.setup();
    const api = joinApi();

    render(
      <CollaborationConnectForm
        api={api}
        status={null}
        t={createTranslator("en")}
        fixedMode="join"
        showHeader={false}
        showConnectionSummary={false}
      />
    );

    await user.type(screen.getByTestId("people-connect-invitation-details"), "not an invite");
    await user.click(screen.getByTestId("people-connect-submit"));

    expect(await screen.findByTestId("people-connect-error")).toHaveTextContent(
      "This invitation is incomplete or invalid"
    );
    expect(api.upsertCollaborationProfile).not.toHaveBeenCalled();
  });
});
