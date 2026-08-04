/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { formatPeoplePanelError, PeopleView } from "../renderer/views/PeopleView";
import {
  parseCollaborationInvitationHandoff,
  serializeCollaborationInvitationHandoff
} from "../renderer/team/collaborationInvitationHandoff";
import { acquireCollaborationReadModelController } from "../renderer/collaboration/collaborationReadModelHub";
import type { CollaborationReadBridgePort } from "../renderer/collaboration/CollaborationReadModelController";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../shared/collaboration";

const scopeLayout = { collapsed: true, expandedProjectIds: [] };
const onScopeLayoutChange = () => undefined;

function invitationHandoff(invitationToken: string, invitationId = "invitation-1") {
  return {
    invitationToken,
    invitation: { invitationId },
    handoff: serializeCollaborationInvitationHandoff({
      endpoint: {
        topology: "lan_http",
        serverOrigin: "http://192.168.1.20:56584/",
        allowedClientOrigins: ["http://192.168.1.20:56584/"],
        tlsTrust: "not_applicable"
      },
      projectId: "authority-project-1",
      invitationToken
    })
  };
}

afterEach(cleanupRendererTestEnvironment);

describe("PeopleView", () => {
  it("localizes structured People rate limits without Electron IPC text", () => {
    const message = formatPeoplePanelError(createTranslator("zh-CN"), {
      kind: "rate_limited",
      code: "human_rate_limited",
      message:
        "Error invoking remote method 'planweave-collaboration:listInvitations': human_rate_limited",
      httpStatus: 429,
      retryAfterMs: 2_000,
      retryable: true
    });

    expect(message).toBe("协作请求过于频繁。请稍候再试。");
    expect(message).not.toContain("Error invoking remote method");
    expect(message).not.toContain("listInvitations");
  });

  it("keeps the connected workspace visible during a transient disconnected status event", async () => {
    let emitStatus: ((status: unknown) => void) | null = null;
    const connectedStatus = {
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
        phase: "connected",
        activeProfileId: "profile-1",
        detail: null,
        lastErrorCode: null,
        lastErrorMessage: null
      },
      workspaceConnection: {
        schemaVersion: "workspace-setup/v1",
        status: "connected",
        profile: null,
        workspaceId: "workspace-1",
        workspaceDisplayName: "Team",
        connectedAt: "2030-01-01T00:00:00.000Z",
        error: null
      },
      workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
      updatedAt: "2030-01-01T00:00:00.000Z"
    } as const;
    const api = {
      getCollaborationStatus: vi.fn().mockResolvedValue(connectedStatus),
      onCollaborationStatusChanged: vi.fn((listener: (status: unknown) => void) => {
        emitStatus = listener;
        return () => undefined;
      }),
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile: null,
        state: "stopped",
        startedAt: null,
        reason: null,
        lanSharingEnabled: false,
        lanServerBaseUrl: null
      }),
      onCollaborationObserverSignal: vi.fn(() => () => undefined),
      listCollaborationContentBootstrapCandidates: vi.fn().mockResolvedValue([])
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <PeopleView
        api={api}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );
    expect(await screen.findByTestId("people-workspace-section")).toBeVisible();
    expect(screen.getByTestId("people-section-nav")).not.toHaveClass(
      "bg-background/95",
      "backdrop-blur"
    );

    emitStatus?.({
      ...connectedStatus,
      session: { ...connectedStatus.session, phase: "idle" },
      workspaceConnection: { ...connectedStatus.workspaceConnection, status: "disconnected" },
      updatedAt: "2030-01-01T00:00:01.000Z"
    });

    await waitFor(() => expect(screen.getByTestId("people-workspace-section")).toBeVisible());
    expect(screen.queryByTestId("collaboration-workspace-onboarding")).not.toBeInTheDocument();
  });

  it("keeps a newer configured status when the initial status request finishes late", async () => {
    let emitStatus: ((status: CollaborationStatus) => void) | null = null;
    let resolveInitialStatus: ((status: CollaborationStatus) => void) | null = null;
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
    } satisfies CollaborationStatus;
    const configuredStatus = {
      ...localOnlyStatus,
      profiles: [
        {
          profileId: "profile-1",
          displayName: "Local workspace",
          serverBaseUrl: "http://127.0.0.1:56584/",
          projectId: "project-1",
          allowInsecureTransport: true,
          hasDeviceCredential: true,
          deviceCredentialPersistence: "persisted",
          deviceCredentialId: "device-1",
          humanPrincipalId: "human-1",
          updatedAt: "2030-01-01T00:00:01.000Z"
        }
      ],
      activeProfileId: "profile-1",
      session: { ...localOnlyStatus.session, activeProfileId: "profile-1" },
      updatedAt: "2030-01-01T00:00:01.000Z"
    } satisfies CollaborationStatus;
    const api = {
      getCollaborationStatus: vi.fn(
        () =>
          new Promise<CollaborationStatus>((resolve) => {
            resolveInitialStatus = resolve;
          })
      ),
      onCollaborationStatusChanged: vi.fn((listener: (status: CollaborationStatus) => void) => {
        emitStatus = listener;
        return () => undefined;
      }),
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile: null,
        state: "stopped",
        startedAt: null,
        reason: null,
        lanSharingEnabled: false,
        lanServerBaseUrl: null
      }),
      onCollaborationObserverSignal: vi.fn(() => () => undefined),
      listCollaborationContentBootstrapCandidates: vi.fn().mockResolvedValue([])
    } as unknown as PlanWeaveCollaborationApi;

    render(
      <PeopleView
        api={api}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );
    await waitFor(() => expect(api.onCollaborationStatusChanged).toHaveBeenCalledOnce());

    act(() => emitStatus?.(configuredStatus));
    expect(await screen.findByTestId("people-workspace-section")).toBeVisible();

    await act(async () => resolveInitialStatus?.(localOnlyStatus));
    expect(screen.getByTestId("people-workspace-section")).toBeVisible();
    expect(screen.queryByTestId("collaboration-workspace-onboarding")).not.toBeInTheDocument();
  });

  it("does not refresh workspace status when opening sharing settings", async () => {
    const user = userEvent.setup();
    const connectedStatus = {
      profiles: [
        {
          profileId: "profile-1",
          displayName: "Team workspace",
          serverBaseUrl: "http://127.0.0.1:56584/",
          projectId: "project-1",
          allowInsecureTransport: true,
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
        phase: "connected",
        activeProfileId: "profile-1",
        detail: null,
        lastErrorCode: null,
        lastErrorMessage: null
      },
      workspaceConnection: {
        schemaVersion: "workspace-setup/v1",
        status: "connected",
        profile: null,
        workspaceId: "workspace-1",
        workspaceDisplayName: "Team",
        connectedAt: "2030-01-01T00:00:00.000Z",
        error: null
      },
      workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
      updatedAt: "2030-01-01T00:00:00.000Z"
    } as const;
    const getCollaborationStatus = vi.fn().mockResolvedValue(connectedStatus);
    const api = {
      getCollaborationStatus,
      onCollaborationStatusChanged: vi.fn(() => () => undefined),
      onCollaborationObserverSignal: vi.fn(() => () => undefined),
      listCollaborationContentBootstrapCandidates: vi.fn().mockResolvedValue([]),
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
        lanSharingEnabled: false,
        lanServerBaseUrl: null
      }),
      getLocalCollaborationScopeCatalog: vi.fn().mockResolvedValue({
        projects: [],
        selectedCount: 0
      }),
      listLocalCollaborationTrustedScopes: vi.fn().mockResolvedValue([])
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

    expect(await screen.findByTestId("people-workspace-section")).toBeVisible();
    expect(screen.queryByTestId("content-authority-panel")).not.toBeInTheDocument();
    await user.click(await screen.findByTestId("people-section-hosting"));
    expect(await screen.findByTestId("people-hosting-section")).toBeVisible();
    expect(screen.getByTestId("deployment-connection")).toBeVisible();
    expect(screen.getByTestId("content-authority-panel")).toBeVisible();
    await waitFor(() => expect(api.getLocalCollaborationScopeCatalog).toHaveBeenCalledOnce());
    expect(getCollaborationStatus).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("collaboration-workspace-onboarding")).not.toBeInTheDocument();
  });

  it("keeps an explicitly created complete invitation across workspace and hosting tab switches", async () => {
    const user = userEvent.setup();
    const invitationToken = `pw_inv_${"P".repeat(43)}`;
    const connectedStatus = {
      profiles: [
        {
          profileId: "profile-1",
          displayName: "Team workspace",
          serverBaseUrl: "http://127.0.0.1:56584/",
          projectId: "project-1",
          allowInsecureTransport: true,
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
        phase: "connected",
        activeProfileId: "profile-1",
        detail: null,
        lastErrorCode: null,
        lastErrorMessage: null
      },
      workspaceConnection: {
        schemaVersion: "workspace-setup/v1",
        status: "connected",
        profile: null,
        workspaceId: "workspace-1",
        workspaceDisplayName: "Team",
        connectedAt: "2030-01-01T00:00:00.000Z",
        error: null
      },
      workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
      updatedAt: "2030-01-01T00:00:00.000Z"
    } as const;
    const createInvitation = vi.fn().mockResolvedValue(invitationHandoff(invitationToken));
    const api = {
      getCollaborationStatus: vi.fn().mockResolvedValue(connectedStatus),
      onCollaborationStatusChanged: vi.fn(() => () => undefined),
      onCollaborationObserverSignal: vi.fn(() => () => undefined),
      listCollaborationContentBootstrapCandidates: vi.fn().mockResolvedValue([]),
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
            canvases: [{ canvasId: "canvas-1", name: "Canvas One", selected: true, current: true }]
          }
        ],
        selectedCount: 1
      }),
      listLocalCollaborationTrustedScopes: vi.fn().mockResolvedValue([]),
      registerLocalCollaborationCurrentProject: vi.fn().mockResolvedValue({
        workspaceId: "workspace-1",
        projectId: "authority-project-1",
        canvasId: "canvas-1",
        profileId: "profile-1",
        registeredAt: "2030-01-01T00:00:01.000Z"
      }),
      createCollaborationInvitationHandoff: createInvitation
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

    expect(await screen.findByTestId("people-workspace-section")).toBeVisible();
    expect(createInvitation).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("people-section-hosting"));
    expect(await screen.findByText("http://192.168.1.20:56584/")).toBeVisible();
    expect(createInvitation).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("people-section-workspace"));
    await user.click(screen.getByTestId("people-section-hosting"));
    expect(createInvitation).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Create complete invitation" }));
    const firstInvitation = (await screen.findByRole("textbox", {
      name: "Complete invitation (shown on this page only)"
    })) as HTMLTextAreaElement;
    expect(createInvitation).toHaveBeenCalledTimes(1);
    expect(parseCollaborationInvitationHandoff(firstInvitation.value)).toMatchObject({
      serverBaseUrl: "http://192.168.1.20:56584/",
      projectId: "authority-project-1",
      invitationToken,
      allowInsecureTransport: true
    });

    const handoff = firstInvitation.value;
    await user.click(screen.getByTestId("people-section-workspace"));
    await user.click(screen.getByTestId("people-section-hosting"));
    expect(
      await screen.findByRole("textbox", {
        name: "Complete invitation (shown on this page only)"
      })
    ).toHaveValue(handoff);
    expect(createInvitation).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Create complete invitation" }));
    await waitFor(() => expect(createInvitation).toHaveBeenCalledTimes(2));
    const firstIdempotencyKey = (createInvitation.mock.calls[0]![0] as { idempotencyKey?: unknown })
      .idempotencyKey;
    const secondIdempotencyKey = (
      createInvitation.mock.calls[1]![0] as { idempotencyKey?: unknown }
    ).idempotencyKey;
    expect(firstIdempotencyKey).toEqual(expect.any(String));
    expect(secondIdempotencyKey).toEqual(expect.any(String));
    expect(secondIdempotencyKey).not.toBe(firstIdempotencyKey);
  });

  it("opens invitation management when local hosting reaches the open-invitation limit", async () => {
    const user = userEvent.setup();
    const connectedStatus = {
      profiles: [
        {
          profileId: "profile-1",
          displayName: "Team workspace",
          serverBaseUrl: "http://127.0.0.1:56584/",
          projectId: "project-1",
          allowInsecureTransport: true,
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
        phase: "connected",
        activeProfileId: "profile-1",
        detail: null,
        lastErrorCode: null,
        lastErrorMessage: null
      },
      workspaceConnection: {
        schemaVersion: "workspace-setup/v1",
        status: "connected",
        profile: null,
        workspaceId: "workspace-1",
        workspaceDisplayName: "Team",
        connectedAt: "2030-01-01T00:00:00.000Z",
        error: null
      },
      workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
      updatedAt: "2030-01-01T00:00:00.000Z"
    } as const;
    const listCollaborationInvitations = vi.fn().mockResolvedValue({
      items: [],
      nextCursor: null
    });
    const listCollaborationDevices = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const api = {
      getCollaborationStatus: vi.fn().mockResolvedValue(connectedStatus),
      onCollaborationStatusChanged: vi.fn(() => () => undefined),
      onCollaborationObserverSignal: vi.fn(() => () => undefined),
      listCollaborationContentBootstrapCandidates: vi.fn().mockResolvedValue([]),
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
            canvases: [{ canvasId: "canvas-1", name: "Canvas One", selected: true, current: true }]
          }
        ],
        selectedCount: 1
      }),
      listLocalCollaborationTrustedScopes: vi.fn().mockResolvedValue([]),
      registerLocalCollaborationCurrentProject: vi.fn().mockResolvedValue({
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "canvas-1",
        profileId: "profile-1",
        registeredAt: "2030-01-01T00:00:01.000Z"
      }),
      createCollaborationInvitationHandoff: vi.fn().mockRejectedValue({
        kind: "conflict",
        code: "human_limit_exceeded",
        message: "human_limit_exceeded",
        httpStatus: 409,
        retryable: false
      }),
      listCollaborationMembers: vi.fn().mockResolvedValue({
        items: [
          {
            membershipId: "membership-owner",
            projectId: "project-1",
            humanPrincipalId: "human-1",
            displayName: "Owner",
            role: "owner",
            createdAt: "2030-01-01T00:00:00.000Z",
            updatedAt: "2030-01-01T00:00:00.000Z"
          }
        ],
        nextCursor: null
      }),
      listCollaborationAssignments: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      listCollaborationActivity: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      listCollaborationInvitations,
      listCollaborationDevices
    } as unknown as PlanWeaveCollaborationApi & CollaborationReadBridgePort;

    const shell = acquireCollaborationReadModelController(api);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "canvas-1"
    });

    render(
      <PeopleView
        api={api}
        canvasId="canvas-1"
        t={createTranslator("zh-CN")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    expect(await screen.findByTestId("people-workspace-section")).toBeVisible();
    await waitFor(() => expect(listCollaborationInvitations).toHaveBeenCalled());
    listCollaborationInvitations.mockClear();
    listCollaborationDevices.mockClear();

    await user.click(screen.getByTestId("people-section-hosting"));
    await user.click(await screen.findByRole("button", { name: "新建完整邀请" }));
    await user.click(await screen.findByRole("button", { name: "管理开放邀请" }));

    expect(await screen.findByTestId("people-workspace-section")).toBeVisible();
    await waitFor(() => expect(listCollaborationInvitations).toHaveBeenCalledOnce());
    expect(listCollaborationDevices).toHaveBeenCalledOnce();
    shell.release();
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

  it("leaves local hosting onboarding after workspace connection succeeds", async () => {
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
        ]),
      listCollaborationContentBootstrapCandidates: vi.fn().mockResolvedValue([])
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
    expect(await screen.findByTestId("people-workspace-section")).toBeVisible();
    expect(screen.queryByTestId("collaboration-workspace-onboarding")).not.toBeInTheDocument();
    expect(screen.queryByTestId("local-collaboration-server-panel")).not.toBeInTheDocument();
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

  it("keeps a stored credential workspace visible while it is disconnected", async () => {
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

    expect(await screen.findByTestId("people-workspace-section")).toBeVisible();
    expect(screen.getByTestId("people-panel")).toBeVisible();
    expect(screen.queryByTestId("collaboration-workspace-onboarding")).not.toBeInTheDocument();
  });

  it("reconnects a stored project session when refresh is clicked while disconnected", async () => {
    const user = userEvent.setup();
    const disconnectedStatus = {
      profiles: [
        {
          profileId: "profile-1",
          displayName: "Team workspace",
          serverBaseUrl: "http://192.168.123.23:56584/",
          projectId: "project-1",
          allowInsecureTransport: true,
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
        phase: "error",
        activeProfileId: "profile-1",
        detail: "connect_preflight_failed",
        lastErrorCode: "collaboration_offline",
        lastErrorMessage: "Network request failed."
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
    } satisfies CollaborationStatus;
    const connectedStatus = {
      ...disconnectedStatus,
      session: {
        phase: "connected",
        activeProfileId: "profile-1",
        detail: null,
        lastErrorCode: null,
        lastErrorMessage: null
      },
      updatedAt: "2030-01-01T00:00:01.000Z"
    } satisfies CollaborationStatus;
    const connectCollaborationSession = vi.fn().mockResolvedValue(connectedStatus);
    const getCollaborationStatus = vi
      .fn()
      .mockResolvedValueOnce(disconnectedStatus)
      .mockResolvedValue(connectedStatus);
    const api = {
      getCollaborationStatus,
      connectCollaborationSession,
      onCollaborationStatusChanged: vi.fn(() => () => undefined),
      onCollaborationObserverSignal: vi.fn(() => () => undefined),
      listCollaborationContentBootstrapCandidates: vi.fn().mockResolvedValue([]),
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

    await user.click(await screen.findByTestId("people-refresh-details"));

    await waitFor(() =>
      expect(connectCollaborationSession).toHaveBeenCalledWith({ profileId: "profile-1" })
    );
    expect(getCollaborationStatus).toHaveBeenCalledTimes(2);
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
