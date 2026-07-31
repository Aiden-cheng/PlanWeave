/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import {
  PeopleView,
  resolveCollaborationInvitationServerBaseUrl
} from "../renderer/views/PeopleView";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration";

const scopeLayout = { collapsed: true, expandedProjectIds: [] };
const onScopeLayoutChange = () => undefined;

afterEach(cleanupRendererTestEnvironment);

describe("PeopleView", () => {
  it("uses the LAN endpoint for the same running local server even when service and project profile IDs differ", () => {
    const activeProfile = {
      profileId: "planweave-local-project-hash",
      displayName: "Local project",
      serverBaseUrl: "http://127.0.0.1:56584/",
      projectId: "project-1",
      allowInsecureTransport: true,
      hasDeviceCredential: true,
      deviceCredentialPersistence: "persisted" as const,
      deviceCredentialId: "device-1",
      humanPrincipalId: "human-1",
      updatedAt: "2030-01-01T00:00:00.000Z"
    };

    expect(
      resolveCollaborationInvitationServerBaseUrl(activeProfile, {
        profile: {
          profileId: "planweave-local-server",
          displayName: "Local server",
          serverBaseUrl: "http://127.0.0.1:56584/",
          allowInsecureTransport: true
        },
        state: "running",
        startedAt: "2030-01-01T00:00:00.000Z",
        reason: null,
        lanSharingEnabled: true,
        lanServerBaseUrl: "http://192.168.1.20:56584/"
      })
    ).toBe("http://192.168.1.20:56584/");

    expect(
      resolveCollaborationInvitationServerBaseUrl(activeProfile, {
        profile: {
          profileId: "another-server",
          displayName: "Other server",
          serverBaseUrl: "http://127.0.0.1:60000/",
          allowInsecureTransport: true
        },
        state: "running",
        startedAt: "2030-01-01T00:00:00.000Z",
        reason: null,
        lanSharingEnabled: true,
        lanServerBaseUrl: "http://192.168.1.20:60000/"
      })
    ).toBe("http://127.0.0.1:56584/");
  });

  it("does not flash first-time onboarding while persisted collaboration status is loading", () => {
    const api = {
      getCollaborationStatus: vi.fn(() => new Promise(() => undefined)),
      onCollaborationStatusChanged: vi.fn(() => () => undefined),
      getLocalCollaborationServerStatus: vi.fn(() => new Promise(() => undefined))
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <PeopleView
        api={api}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent("Working");
    expect(screen.queryByTestId("collaboration-workspace-onboarding")).not.toBeInTheDocument();
  });

  it("shows a progressive create-or-join entry before a workspace is connected", () => {
    render(
      <PeopleView
        api={null}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    expect(screen.getByTestId("people-view")).toHaveAccessibleName("Project people");
    expect(screen.getByTestId("people-view")).not.toHaveClass("border");
    expect(screen.queryByRole("heading", { name: "Project people" })).not.toBeInTheDocument();
    expect(screen.getByTestId("collaboration-workspace-onboarding")).toBeInTheDocument();
    expect(screen.getByTestId("collaboration-onboarding-create")).toHaveTextContent(
      "Create a collaboration workspace"
    );
    expect(screen.getByTestId("collaboration-onboarding-join")).toHaveTextContent(
      "Join a collaboration workspace"
    );
    expect(screen.queryByTestId("people-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("people-section-hosting")).not.toBeInTheDocument();
  });

  it("reveals only the selected create or join flow", async () => {
    const user = userEvent.setup();
    render(
      <PeopleView
        api={null}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    await user.click(screen.getByTestId("collaboration-onboarding-create"));
    expect(screen.getByTestId("collaboration-onboarding-host-locally")).toBeVisible();
    expect(screen.getByTestId("collaboration-onboarding-existing-server")).toBeVisible();
    expect(screen.queryByTestId("people-connect-form")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("collaboration-onboarding-existing-server"));
    expect(screen.getByTestId("people-connect-form")).toBeVisible();
    expect(screen.getByTestId("people-connect-setup-details")).toBeInTheDocument();
    expect(screen.queryByTestId("people-connect-mode-join")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByTestId("collaboration-onboarding-join"));
    expect(screen.getByTestId("people-connect-invitation-details")).toBeVisible();
    expect(screen.queryByTestId("people-connect-server-url")).not.toBeInTheDocument();
    expect(screen.queryByTestId("people-connect-project-id")).not.toBeInTheDocument();
  });

  it("keeps the local hosting step visible after workspace connection succeeds", async () => {
    const user = userEvent.setup();
    const localOnlyStatus = {
      profiles: [],
      activeProfileId: null,
      credentialStorage: "available",
      nonPersistenceWarning: null,
      session: {
        phase: "idle",
        activeProfileId: null,
        detail: null,
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
      workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
      updatedAt: "2030-01-01T00:00:00.000Z"
    } as const;
    const connectedStatus = {
      ...localOnlyStatus,
      profiles: [
        {
          profileId: "planweave-local-project-1",
          displayName: "Project One",
          serverBaseUrl: "http://127.0.0.1:56584/",
          projectId: "project-1",
          allowInsecureTransport: true,
          hasDeviceCredential: true,
          deviceCredentialPersistence: "persisted" as const,
          deviceCredentialId: "device-1",
          humanPrincipalId: "human-1",
          updatedAt: "2030-01-01T00:00:01.000Z"
        }
      ],
      activeProfileId: "planweave-local-project-1",
      session: {
        phase: "connected" as const,
        activeProfileId: "planweave-local-project-1",
        detail: null,
        lastErrorCode: null,
        lastErrorMessage: null
      },
      workspaceConnection: {
        ...localOnlyStatus.workspaceConnection,
        status: "connected" as const,
        profile: null,
        workspaceId: "workspace-1",
        workspaceDisplayName: "Local workspace",
        connectedAt: "2030-01-01T00:00:01.000Z"
      },
      updatedAt: "2030-01-01T00:00:01.000Z"
    };
    const getCollaborationStatus = vi
      .fn()
      .mockResolvedValueOnce(localOnlyStatus)
      .mockResolvedValue(connectedStatus);
    const api = {
      getCollaborationStatus,
      onCollaborationStatusChanged: vi.fn(() => () => undefined),
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile: {
          profileId: "planweave-local-server",
          displayName: "Local collaboration server",
          serverBaseUrl: "http://127.0.0.1:56584/",
          allowInsecureTransport: true
        },
        state: "running",
        startedAt: "2030-01-01T00:00:00.000Z",
        reason: null,
        lanSharingEnabled: true,
        lanServerBaseUrl: "http://192.168.1.20:56584/"
      }),
      getLocalCollaborationScopeCatalog: vi.fn().mockResolvedValue({
        projects: [
          {
            projectId: "project-1",
            name: "Project One",
            selectedCanvasCount: 1,
            canvases: [
              {
                canvasId: "canvas-1",
                name: "Canvas One",
                selected: true,
                current: true
              }
            ]
          }
        ],
        selectedCount: 1
      }),
      listLocalCollaborationTrustedScopes: vi
        .fn()
        .mockResolvedValue([
          { workspaceId: "workspace-1", projectId: "project-1", canvasId: "canvas-1" }
        ])
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <PeopleView
        api={api}
        canvasId="canvas-1"
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    await user.click(await screen.findByTestId("collaboration-onboarding-create"));
    await user.click(screen.getByTestId("collaboration-onboarding-host-locally"));

    await waitFor(() => expect(getCollaborationStatus).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("collaboration-workspace-onboarding")).toHaveAttribute(
      "data-step",
      "local"
    );
    expect(screen.getByTestId("local-collaboration-server-panel")).toBeVisible();
    expect(screen.queryByTestId("people-workspace-section")).not.toBeInTheDocument();
  });

  it("hides remote content authority while the project is local only", () => {
    render(
      <PeopleView
        api={null}
        canvasId="canvas-1"
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    expect(screen.queryByTestId("content-authority-panel")).not.toBeInTheDocument();
  });

  it("shows create-or-join onboarding when a stored profile is not connected", async () => {
    const api = {
      getCollaborationStatus: vi.fn().mockResolvedValue({
        profiles: [
          {
            profileId: "profile-1",
            displayName: "Team workspace",
            serverBaseUrl: "https://collaboration.example.test",
            projectId: "project-1",
            allowInsecureTransport: false,
            hasDeviceCredential: true,
            deviceCredentialPersistence: "persisted",
            deviceCredentialId: "device-1",
            humanPrincipalId: "human-1",
            updatedAt: "2030-01-01T00:00:00.000Z"
          }
        ],
        activeProfileId: "profile-1",
        credentialStorage: "available",
        nonPersistenceWarning: null,
        session: {
          phase: "idle",
          activeProfileId: "profile-1",
          detail: null,
          lastErrorCode: null,
          lastErrorMessage: null
        },
        workspaceConnection: {
          schemaVersion: "workspace-setup/v1",
          status: "disconnected",
          profile: null,
          workspaceId: null,
          workspaceDisplayName: null,
          connectedAt: null,
          error: null
        },
        workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
        updatedAt: "2030-01-01T00:00:00.000Z"
      }),
      onCollaborationStatusChanged: vi.fn(() => () => undefined),
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile: null,
        state: "stopped",
        startedAt: null,
        reason: null,
        lanSharingEnabled: false,
        lanServerBaseUrl: null
      })
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <PeopleView
        api={api}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    expect(await screen.findByTestId("collaboration-workspace-onboarding")).toBeVisible();
    expect(screen.getByTestId("collaboration-onboarding-create")).toBeVisible();
    expect(screen.getByTestId("collaboration-onboarding-join")).toBeVisible();
    expect(screen.queryByTestId("people-panel")).not.toBeInTheDocument();
  });

  it("keeps onboarding visible when a failed join left only an uncredentialed profile", async () => {
    const api = {
      getCollaborationStatus: vi.fn().mockResolvedValue({
        profiles: [
          {
            profileId: "profile-failed-join",
            displayName: "Failed join",
            serverBaseUrl: "https://collaboration.example.test",
            projectId: "project-1",
            allowInsecureTransport: false,
            hasDeviceCredential: false,
            deviceCredentialPersistence: "missing",
            deviceCredentialId: null,
            humanPrincipalId: null,
            updatedAt: "2030-01-01T00:00:00.000Z"
          }
        ],
        activeProfileId: null,
        credentialStorage: "available",
        nonPersistenceWarning: null,
        session: {
          phase: "idle",
          activeProfileId: null,
          detail: null,
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
        workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
        updatedAt: "2030-01-01T00:00:00.000Z"
      }),
      onCollaborationStatusChanged: vi.fn(() => () => undefined),
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile: null,
        state: "stopped",
        startedAt: null,
        reason: null,
        lanSharingEnabled: false,
        lanServerBaseUrl: null
      })
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <PeopleView
        api={api}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    expect(await screen.findByTestId("collaboration-workspace-onboarding")).toBeVisible();
    expect(screen.queryByTestId("people-panel")).not.toBeInTheDocument();
  });
});
