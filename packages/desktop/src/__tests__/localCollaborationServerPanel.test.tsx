/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalCollaborationServerPanel } from "../renderer/collaboration/LocalCollaborationServerPanel";
import { createTranslator } from "../renderer/i18n";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration";

const profile = {
  profileId: "planweave-local-server",
  displayName: "Local collaboration server",
  serverBaseUrl: "http://127.0.0.1:8787/",
  allowInsecureTransport: true
};
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
    getLocalCollaborationServerStatus: vi
      .fn()
      .mockResolvedValue({ profile: null, state: "stopped", startedAt: null, reason: null }),
    startLocalCollaborationServer: vi.fn().mockResolvedValue({
      profile,
      state: "running",
      startedAt: "2030-01-01T00:00:00.000Z",
      reason: null
    }),
    stopLocalCollaborationServer: vi
      .fn()
      .mockResolvedValue({ profile: null, state: "stopped", startedAt: null, reason: null }),
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
  it("requires an explicit canvas selection before starting", async () => {
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
      />
    );

    const start = await screen.findByRole("button", { name: "Start with 0 canvases" });
    expect(start).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "Project One / Canvas One" }));
    await userEvent.click(screen.getByRole("button", { name: "Start with 1 canvases" }));

    await waitFor(() =>
      expect(collaborationApi.setLocalCollaborationTrustedScopes).toHaveBeenCalledWith({
        scopes: [{ projectId: "desktop-project-1", canvasId: "canvas-1" }]
      })
    );
    expect(collaborationApi.startLocalCollaborationServer).toHaveBeenCalled();
  });

  it("starts, loads trusted scopes, and registers the current canvas", async () => {
    const collaborationApi = api({
      getLocalCollaborationServerStatus: vi
        .fn()
        .mockResolvedValueOnce({ profile: null, state: "stopped", startedAt: null, reason: null })
        .mockResolvedValue({
          profile,
          state: "running",
          startedAt: "2030-01-01T00:00:00.000Z",
          reason: null
        })
    });
    render(
      <LocalCollaborationServerPanel
        api={collaborationApi}
        t={createTranslator("en")}
        projectId="project-1"
        canvasId="canvas-1"
      />
    );
    await userEvent.click(await screen.findByRole("button", { name: "Start with 1 canvases" }));
    await waitFor(() =>
      expect(collaborationApi.listLocalCollaborationTrustedScopes).toHaveBeenCalled()
    );
    await userEvent.click(screen.getByRole("button", { name: "Enable current canvas" }));
    await waitFor(() =>
      expect(collaborationApi.registerLocalCollaborationCurrentProject).toHaveBeenCalledWith({
        ownerDisplayName: "Local owner"
      })
    );
    expect(screen.getByText(/Registered:/)).toHaveTextContent("2030-01-01T00:00:01.000Z");
  });

  it("surfaces registration failures without retrying from the renderer", async () => {
    const collaborationApi = api({
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({
        profile,
        state: "running",
        startedAt: "2030-01-01T00:00:00.000Z",
        reason: null
      }),
      registerLocalCollaborationCurrentProject: vi
        .fn()
        .mockRejectedValue(new Error("local_collaboration_owner_initialization_required"))
    });
    render(
      <LocalCollaborationServerPanel
        api={collaborationApi}
        t={createTranslator("en")}
        projectId="project-1"
        canvasId="canvas-1"
      />
    );
    await userEvent.click(await screen.findByRole("button", { name: "Enable current canvas" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "local_collaboration_owner_initialization_required"
    );
    expect(collaborationApi.registerLocalCollaborationCurrentProject).toHaveBeenCalledTimes(1);
  });
});
