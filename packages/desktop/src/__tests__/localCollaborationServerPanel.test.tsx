/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalCollaborationServerPanel } from "../renderer/collaboration/LocalCollaborationServerPanel";
import { createTranslator } from "../renderer/i18n";
import { parseCollaborationInvitationHandoff } from "../renderer/team/collaborationInvitationHandoff";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration";

const profile = {
  profileId: "planweave-local-server",
  displayName: "Local collaboration server",
  serverBaseUrl: "http://127.0.0.1:8787/",
  allowInsecureTransport: true
};
const expandedScopeLayout = {
  collapsed: false,
  expandedProjectIds: ["desktop-project-1"]
};
const onScopeLayoutChange = vi.fn();
const copyText = vi.fn(async () => undefined);
afterEach(cleanup);

function api(overrides: Partial<PlanWeaveCollaborationApi> = {}): PlanWeaveCollaborationApi {
  const catalog = {
    projects: [
      {
        projectId: "desktop-project-1",
        name: "Project One",
        selectedCanvasCount: 1,
        canvases: [{ canvasId: "canvas-1", name: "Canvas One", selected: true, current: true }]
      }
    ],
    selectedCount: 1
  };
  return {
    getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
      profile: null,
      state: "stopped",
      startedAt: null,
      reason: null,
      lanSharingEnabled: false,
      lanServerBaseUrl: null
    }),
    startLocalCollaborationServer: vi.fn().mockResolvedValue({
      profile,
      state: "running",
      startedAt: "2030-01-01T00:00:00.000Z",
      reason: null,
      lanSharingEnabled: false,
      lanServerBaseUrl: null
    }),
    stopLocalCollaborationServer: vi.fn().mockResolvedValue({
      profile: null,
      state: "stopped",
      startedAt: null,
      reason: null,
      lanSharingEnabled: false,
      lanServerBaseUrl: null
    }),
    setLocalCollaborationLanSharing: vi.fn().mockResolvedValue({
      profile,
      state: "running",
      startedAt: "2030-01-01T00:00:00.000Z",
      reason: null,
      lanSharingEnabled: true,
      lanServerBaseUrl: "http://192.168.1.20:8787/"
    }),
    listLocalCollaborationTrustedScopes: vi
      .fn()
      .mockResolvedValue([
        { workspaceId: "workspace-1", projectId: "project-1", canvasId: "canvas-1" }
      ]),
    getLocalCollaborationScopeCatalog: vi.fn().mockResolvedValue(catalog),
    setLocalCollaborationTrustedScopes: vi.fn().mockResolvedValue(catalog),
    bootstrapCollaborationOwner: vi.fn().mockResolvedValue({
      deviceCredentialPersistence: "persisted",
      nonPersistenceWarning: null
    }),
    registerLocalCollaborationCurrentProject: vi.fn().mockResolvedValue({
      workspaceId: "workspace-1",
      projectId: "project-1",
      canvasId: "canvas-1",
      profileId: profile.profileId,
      registeredAt: "2030-01-01T00:00:01.000Z"
    }),
    ...overrides
  } as PlanWeaveCollaborationApi;
}

describe("LocalCollaborationServerPanel", () => {
  it("applies an explicit canvas selection and lets main start the internal service", async () => {
    const emptyCatalog = {
      projects: [
        {
          projectId: "desktop-project-1",
          name: "Project One",
          selectedCanvasCount: 0,
          canvases: [{ canvasId: "canvas-1", name: "Canvas One", selected: false, current: true }]
        }
      ],
      selectedCount: 0
    };
    const selectedCatalog = {
      ...emptyCatalog,
      selectedCount: 1,
      projects: [
        {
          ...emptyCatalog.projects[0],
          selectedCanvasCount: 1,
          canvases: [{ ...emptyCatalog.projects[0]!.canvases[0]!, selected: true }]
        }
      ]
    };
    const collaborationApi = api({
      getLocalCollaborationScopeCatalog: vi.fn().mockResolvedValue(emptyCatalog),
      setLocalCollaborationTrustedScopes: vi.fn().mockResolvedValue(selectedCatalog)
    });
    render(
      <LocalCollaborationServerPanel
        api={collaborationApi}
        t={createTranslator("en")}
        projectId="project-1"
        canvasId="canvas-1"
        scopeLayout={expandedScopeLayout}
        onScopeLayoutChange={onScopeLayoutChange}
        copyText={copyText}
      />
    );

    await userEvent.click(
      await screen.findByRole("checkbox", { name: "Project One / Canvas One" })
    );
    await userEvent.click(screen.getByRole("button", { name: "Apply changes" }));

    await waitFor(() =>
      expect(collaborationApi.setLocalCollaborationTrustedScopes).toHaveBeenCalledWith({
        scopes: [{ projectId: "desktop-project-1", canvasId: "canvas-1" }]
      })
    );
    expect(collaborationApi.startLocalCollaborationServer).not.toHaveBeenCalled();
  });

  it("shows an automatically activated canvas without a second initialization action", async () => {
    const collaborationApi = api({
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile,
        state: "running",
        startedAt: "2030-01-01T00:00:00.000Z",
        reason: null,
        lanSharingEnabled: false,
        lanServerBaseUrl: null
      })
    });
    render(
      <LocalCollaborationServerPanel
        api={collaborationApi}
        t={createTranslator("en")}
        projectId="project-1"
        canvasId="canvas-1"
        scopeLayout={expandedScopeLayout}
        onScopeLayoutChange={onScopeLayoutChange}
        copyText={copyText}
      />
    );
    await waitFor(() =>
      expect(collaborationApi.listLocalCollaborationTrustedScopes).toHaveBeenCalled()
    );
    expect(screen.getByText("Current canvas collaboration is active")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Enable current canvas" })).not.toBeInTheDocument();
    expect(collaborationApi.registerLocalCollaborationCurrentProject).not.toHaveBeenCalled();
  });

  it("persists the catalog and per-project disclosure state", async () => {
    const collaborationApi = api();
    const onLayoutChange = vi.fn();
    const { rerender } = render(
      <LocalCollaborationServerPanel
        api={collaborationApi}
        t={createTranslator("en")}
        projectId="project-1"
        canvasId="canvas-1"
        scopeLayout={expandedScopeLayout}
        onScopeLayoutChange={onLayoutChange}
        copyText={copyText}
      />
    );

    expect(
      await screen.findByRole("checkbox", { name: "Project One / Canvas One" })
    ).toBeInTheDocument();
    expect(screen.getByTestId("local-collaboration-server-panel")).not.toHaveClass(
      "rounded-xl",
      "shadow-sm",
      "bg-background"
    );
    await userEvent.click(screen.getByRole("button", { name: "Hide hosted canvas selection" }));
    expect(onLayoutChange).toHaveBeenLastCalledWith({ collapsed: true });

    rerender(
      <LocalCollaborationServerPanel
        api={collaborationApi}
        t={createTranslator("en")}
        projectId="project-1"
        canvasId="canvas-1"
        scopeLayout={{ collapsed: true, expandedProjectIds: [] }}
        onScopeLayoutChange={onLayoutChange}
        copyText={copyText}
      />
    );
    expect(screen.queryByTestId("local-collaboration-scope-catalog")).not.toBeInTheDocument();

    rerender(
      <LocalCollaborationServerPanel
        api={collaborationApi}
        t={createTranslator("en")}
        projectId="project-1"
        canvasId="canvas-1"
        scopeLayout={{ collapsed: false, expandedProjectIds: [] }}
        onScopeLayoutChange={onLayoutChange}
        copyText={copyText}
      />
    );
    expect(screen.getByRole("button", { name: "Show canvases in Project One" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    expect(
      screen.queryByRole("checkbox", { name: "Project One / Canvas One" })
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show canvases in Project One" }));
    expect(onLayoutChange).toHaveBeenLastCalledWith({
      expandedProjectIds: ["desktop-project-1"]
    });
  });

  it("enables LAN sharing and keeps raw address copying as a secondary action", async () => {
    const collaborationApi = api({
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile,
        state: "running",
        startedAt: "2030-01-01T00:00:00.000Z",
        reason: null,
        lanSharingEnabled: true,
        lanServerBaseUrl: "http://192.168.1.20:8787/"
      })
    });
    const copy = vi.fn(async () => undefined);
    render(
      <LocalCollaborationServerPanel
        api={collaborationApi}
        t={createTranslator("en")}
        projectId="project-1"
        canvasId="canvas-1"
        scopeLayout={expandedScopeLayout}
        onScopeLayoutChange={onScopeLayoutChange}
        copyText={copy}
      />
    );

    expect(await screen.findByText("http://192.168.1.20:8787/")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Copy address only" }));
    expect(copy).toHaveBeenCalledWith("http://192.168.1.20:8787/");
    await userEvent.click(screen.getByRole("switch", { name: "Share on local network" }));
    expect(collaborationApi.setLocalCollaborationLanSharing).toHaveBeenCalledWith({
      enabled: false
    });
  });

  it("creates and copies a complete project invitation from the local hosting page", async () => {
    const invitationToken = `pw_inv_${"A".repeat(43)}`;
    const collaborationApi = api({
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile,
        state: "running",
        startedAt: "2030-01-01T00:00:00.000Z",
        reason: null,
        lanSharingEnabled: true,
        lanServerBaseUrl: "http://192.168.1.20:8787/"
      }),
      getCollaborationStatus: vi.fn().mockResolvedValue({
        profiles: [
          {
            profileId: "planweave-local-project-1",
            displayName: "Local collaboration server",
            serverBaseUrl: profile.serverBaseUrl,
            projectId: "authority-project-1",
            allowInsecureTransport: true,
            hasDeviceCredential: true,
            deviceCredentialPersistence: "persisted",
            deviceCredentialId: "credential-1",
            humanPrincipalId: "principal-1",
            updatedAt: "2030-01-01T00:00:00.000Z"
          }
        ],
        activeProfileId: "planweave-local-project-1",
        session: {
          phase: "connected",
          activeProfileId: "planweave-local-project-1",
          detail: null,
          lastErrorCode: null,
          lastErrorMessage: null
        }
      }),
      createCollaborationInvitation: vi.fn().mockResolvedValue({
        invitationToken,
        invitation: { invitationId: "invitation-1" }
      })
    });
    const copy = vi.fn(async () => undefined);
    render(
      <LocalCollaborationServerPanel
        api={collaborationApi}
        t={createTranslator("en")}
        projectId="project-1"
        canvasId="canvas-1"
        scopeLayout={expandedScopeLayout}
        onScopeLayoutChange={onScopeLayoutChange}
        copyText={copy}
      />
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Create and copy complete invitation" })
    );

    await waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
    const parsed = parseCollaborationInvitationHandoff(copy.mock.calls[0]![0]);
    expect(parsed).toMatchObject({
      serverBaseUrl: "http://192.168.1.20:8787/",
      projectId: "authority-project-1",
      invitationToken,
      allowInsecureTransport: true
    });
    expect(
      screen.getByRole("textbox", {
        name: "Complete invitation (shown on this page only)"
      })
    ).toHaveValue(copy.mock.calls[0]![0]);
    expect(screen.getByText("Complete invitation copied.")).toBeVisible();
    expect(collaborationApi.createCollaborationInvitation).toHaveBeenCalledWith({});
  });
});
