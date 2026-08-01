/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import {
  accessCapabilityFlags,
  serializeCollaborationSetupHandoffV1,
  type CurrentCanvasAccessView
} from "@planweave-ai/collaboration-contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { CollaborationConnectForm } from "../renderer/team/CollaborationConnectForm";
import { buildCollaborationDiagnosticReport } from "../renderer/team/collaborationDiagnostics";
import { serializeCollaborationInvitationHandoff } from "../renderer/team/collaborationInvitationHandoff";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../shared/collaboration";
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
              hasDeviceCredential: true,
              deviceCredentialPersistence: "persisted",
              deviceCredentialId: "device-existing",
              humanPrincipalId: "human-existing",
              updatedAt: "2030-01-01T00:00:00.000Z"
            }
          ],
          session: {
            phase: "connected",
            activeProfileId: "existing-project-profile",
            detail: "observer:connected",
            lastErrorCode: null,
            lastErrorMessage: null
          },
          workspaceConnection: {
            schemaVersion: "workspace-setup/v1",
            status: "local_only",
            profile: null,
            workspaceId: null,
            workspaceDisplayName: null,
            connectedAt: null,
            error: null
          },
          workspacePicker: {
            schemaVersion: "workspace-setup/v1",
            items: [],
            nextCursor: null
          },
          credentialStorage: "available",
          nonPersistenceWarning: null,
          updatedAt: "2030-01-01T00:00:00.000Z"
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

describe("CollaborationConnectForm connection diagnostics", () => {
  const diagnosticStatus: CollaborationStatus = {
    activeProfileId: "profile-windows",
    profiles: [
      {
        profileId: "profile-windows",
        displayName: "Windows member",
        serverBaseUrl: "http://192.168.123.23:62060/",
        projectId: "project-1",
        allowInsecureTransport: true,
        hasDeviceCredential: true,
        deviceCredentialPersistence: "persisted",
        deviceCredentialId: "device-1",
        humanPrincipalId: "human-1",
        updatedAt: "2030-01-01T00:00:00.000Z"
      }
    ],
    credentialStorage: "available",
    nonPersistenceWarning: null,
    session: {
      phase: "connecting",
      activeProfileId: "profile-windows",
      detail: "observer:reconnecting:attempt=3:delay_ms=2000",
      lastErrorCode: null,
      lastErrorMessage: `Bearer pw_hdev_${"S".repeat(43)}`
    },
    workspaceConnection: {
      schemaVersion: "workspace-setup/v1",
      status: "local_only",
      profile: null,
      workspaceId: null,
      workspaceDisplayName: null,
      connectedAt: null,
      error: null
    },
    workspacePicker: {
      schemaVersion: "workspace-setup/v1",
      items: [],
      nextCursor: null
    },
    updatedAt: "2030-01-01T00:00:03.000Z"
  };

  it("connects the Workspace and the active project session as one user action", async () => {
    const user = userEvent.setup();
    const connectWorkspaceConnection = vi.fn().mockResolvedValue(undefined);
    const setActiveCollaborationProfile = vi.fn().mockResolvedValue(undefined);
    const connectCollaborationSession = vi.fn().mockResolvedValue(undefined);
    const onConnected = vi.fn().mockResolvedValue(undefined);
    const api = {
      connectWorkspaceConnection,
      setActiveCollaborationProfile,
      connectCollaborationSession
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <CollaborationConnectForm
        api={api}
        status={{
          ...diagnosticStatus,
          session: {
            ...diagnosticStatus.session,
            phase: "error",
            detail: "observer:failed",
            lastErrorCode: "network_unreachable",
            lastErrorMessage: "network_unreachable"
          },
          workspaceConnection: {
            ...diagnosticStatus.workspaceConnection,
            status: "disconnected"
          }
        }}
        t={createTranslator("en")}
        fixedMode="connect"
        onConnected={onConnected}
      />
    );

    await user.click(screen.getByTestId("people-connect-submit"));

    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(connectWorkspaceConnection).toHaveBeenCalledTimes(1);
    expect(setActiveCollaborationProfile).toHaveBeenCalledWith({
      profileId: "profile-windows"
    });
    expect(connectCollaborationSession).toHaveBeenCalledWith({
      profileId: "profile-windows"
    });
    expect(connectWorkspaceConnection.mock.invocationCallOrder[0]).toBeLessThan(
      setActiveCollaborationProfile.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(setActiveCollaborationProfile.mock.invocationCallOrder[0]).toBeLessThan(
      connectCollaborationSession.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it("updates a stale server address without replacing the existing member identity", async () => {
    const user = userEvent.setup();
    const upsertCollaborationProfile = vi.fn().mockResolvedValue(undefined);
    const setActiveCollaborationProfile = vi.fn().mockResolvedValue(undefined);
    const connectCollaborationSession = vi.fn().mockResolvedValue(undefined);
    const api = {
      upsertCollaborationProfile,
      setActiveCollaborationProfile,
      connectCollaborationSession
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <CollaborationConnectForm
        api={api}
        status={{
          ...diagnosticStatus,
          session: {
            ...diagnosticStatus.session,
            phase: "error",
            detail: "observer:connect_timeout",
            lastErrorCode: "collaboration_observer_connect_timeout",
            lastErrorMessage: "The collaboration observer could not connect before the deadline."
          }
        }}
        t={createTranslator("en")}
        fixedMode="connect"
      />
    );

    const serverUrlInput = screen.getByTestId("people-connect-existing-server-url");
    expect(serverUrlInput).toHaveValue("http://192.168.123.23:62060/");
    await user.clear(serverUrlInput);
    await user.type(serverUrlInput, "http://192.168.123.23:50653/");
    await user.click(screen.getByTestId("people-connect-submit"));

    await waitFor(() => expect(connectCollaborationSession).toHaveBeenCalledTimes(1));
    expect(upsertCollaborationProfile).toHaveBeenCalledWith({
      profileId: "profile-windows",
      displayName: "Windows member",
      serverBaseUrl: "http://192.168.123.23:50653/",
      projectId: "project-1",
      allowInsecureTransport: true
    });
    expect(setActiveCollaborationProfile).toHaveBeenCalledWith({
      profileId: "profile-windows"
    });
    expect(upsertCollaborationProfile.mock.invocationCallOrder[0]).toBeLessThan(
      setActiveCollaborationProfile.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it("rejects an invalid replacement server address before changing the profile", async () => {
    const user = userEvent.setup();
    const upsertCollaborationProfile = vi.fn().mockResolvedValue(undefined);
    const connectCollaborationSession = vi.fn().mockResolvedValue(undefined);
    const api = {
      upsertCollaborationProfile,
      setActiveCollaborationProfile: vi.fn().mockResolvedValue(undefined),
      connectCollaborationSession
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <CollaborationConnectForm
        api={api}
        status={diagnosticStatus}
        t={createTranslator("en")}
        fixedMode="connect"
      />
    );

    const serverUrlInput = screen.getByTestId("people-connect-existing-server-url");
    await user.clear(serverUrlInput);
    await user.type(serverUrlInput, "http://example.com/path");
    await user.click(screen.getByTestId("people-connect-submit"));

    expect(await screen.findByTestId("people-connect-error")).toHaveTextContent(
      "Enter a valid HTTP(S) server origin without a path"
    );
    expect(upsertCollaborationProfile).not.toHaveBeenCalled();
    expect(connectCollaborationSession).not.toHaveBeenCalled();
  });

  it("still connects the active project when the optional Workspace connection fails", async () => {
    const user = userEvent.setup();
    const connectWorkspaceConnection = vi
      .fn()
      .mockRejectedValue(new Error("workspace_connection_unauthorized"));
    const setActiveCollaborationProfile = vi.fn().mockResolvedValue(undefined);
    const connectCollaborationSession = vi.fn().mockResolvedValue(undefined);
    const onConnected = vi.fn().mockResolvedValue(undefined);
    const api = {
      connectWorkspaceConnection,
      setActiveCollaborationProfile,
      connectCollaborationSession
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <CollaborationConnectForm
        api={api}
        status={{
          ...diagnosticStatus,
          session: {
            ...diagnosticStatus.session,
            phase: "error",
            detail: "workspace_connect_failed",
            lastErrorCode: "workspace_connection_unauthorized",
            lastErrorMessage: "workspace_connection_unauthorized"
          },
          workspaceConnection: {
            ...diagnosticStatus.workspaceConnection,
            status: "error",
            error: {
              code: "workspace_connection_unauthorized",
              message: "Workspace authorization failed.",
              retryable: false
            }
          }
        }}
        t={createTranslator("en")}
        fixedMode="connect"
        onConnected={onConnected}
      />
    );

    await user.click(screen.getByTestId("people-connect-submit"));

    await waitFor(() => expect(connectCollaborationSession).toHaveBeenCalledTimes(1));
    expect(setActiveCollaborationProfile).toHaveBeenCalledWith({
      profileId: "profile-windows"
    });
    expect(connectCollaborationSession).toHaveBeenCalledWith({
      profileId: "profile-windows"
    });
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("builds an allowlisted report with the observer target and redacted secrets", () => {
    const accessView: CurrentCanvasAccessView = {
      scope: {
        scopeKind: "canvas",
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "default"
      },
      projectVisibility: "private",
      canvasVisibility: "shared",
      projectAclRevision: 1,
      canvasAclRevision: 2,
      project: {
        scope: {
          scopeKind: "project",
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: null
        },
        aclRevision: 1,
        effectiveRole: null,
        roleSource: "none",
        capabilities: accessCapabilityFlags(null),
        disabledReason: "role_missing"
      },
      canvas: {
        scope: {
          scopeKind: "canvas",
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: "default"
        },
        aclRevision: 2,
        effectiveRole: "viewer",
        roleSource: "shared_visibility",
        capabilities: accessCapabilityFlags("viewer"),
        disabledReason: null
      },
      people: []
    };
    const report = buildCollaborationDiagnosticReport(diagnosticStatus, "Win32", {
      profileId: "profile-windows",
      projectId: "project-1",
      canvasId: "default",
      syncPhase: "error",
      observerCursor: 42,
      members: [],
      loadingKinds: ["members"],
      lastError: {
        kind: "rate_limit",
        code: "human_rate_limited",
        message: `Bearer pw_hdev_${"T".repeat(43)}`,
        httpStatus: 429,
        retryAfterMs: 1500,
        retryable: true
      },
      updatedAt: "2030-01-01T00:00:04.000Z"
    }, accessView);

    expect(report).toContain("platform=Win32");
    expect(report).toContain(
      "profile.observer_url=ws://192.168.123.23:62060/api/v1/projects/project-1/human/observe"
    );
    expect(report).toContain("session.detail=observer:reconnecting:attempt=3:delay_ms=2000");
    expect(report).toContain(
      "profile.members_url=http://192.168.123.23:62060/api/v1/projects/project-1/human/members"
    );
    expect(report).toContain("read_model.loading_kinds=members");
    expect(report).toContain("read_model.error_code=human_rate_limited");
    expect(report).toContain("read_model.error_http_status=429");
    expect(report).toContain("read_model.error_retry_after_ms=1500");
    expect(report).toContain("access.workspace_id=workspace-1");
    expect(report).toContain("access.project_visibility=private");
    expect(report).toContain("access.project_role=none");
    expect(report).toContain("access.project_disabled_reason=role_missing");
    expect(report).toContain("access.canvas_visibility=shared");
    expect(report).toContain("access.canvas_role=viewer");
    expect(report).toContain("access.canvas_role_source=shared_visibility");
    expect(report).toContain("session.error_message=[REDACTED]");
    expect(report).not.toContain("pw_hdev_");
  });

  it("keeps diagnostics collapsed and copies the redacted report on demand", async () => {
    const user = userEvent.setup();
    const copyText = vi.fn().mockResolvedValue(undefined);

    render(
      <CollaborationConnectForm
        api={joinApi()}
        status={diagnosticStatus}
        t={createTranslator("en")}
        fixedMode="connect"
        copyText={copyText}
      />
    );

    expect(screen.getByTestId("people-connection-diagnostics")).not.toHaveAttribute("open");
    await user.click(screen.getByText("Connection diagnostics"));
    await user.click(screen.getByTestId("people-connection-diagnostics-copy"));

    expect(copyText).toHaveBeenCalledTimes(1);
    expect(copyText.mock.calls[0]?.[0]).toContain("planweave.collaboration.diagnostics/v1");
    expect(copyText.mock.calls[0]?.[0]).not.toContain("pw_hdev_");
    expect(screen.getByTestId("people-connection-diagnostics-copy")).toHaveTextContent(
      "Diagnostics copied"
    );
  });
});
