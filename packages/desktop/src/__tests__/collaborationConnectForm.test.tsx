/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
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
