/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalCollaborationServerPanel } from "../renderer/collaboration/LocalCollaborationServerPanel";
import { createTranslator } from "../renderer/i18n";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration";

const profile = {
  profileId: "planweave-local-loopback",
  displayName: "Local collaboration server",
  serverBaseUrl: "http://127.0.0.1:8787/",
  allowInsecureTransport: true
};

afterEach(cleanup);

function api(overrides: Partial<PlanWeaveCollaborationApi> = {}): PlanWeaveCollaborationApi {
  return {
    getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({ profile: null, state: "stopped", startedAt: null, reason: null }),
    startLocalCollaborationServer: vi.fn().mockResolvedValue({ profile, state: "running", startedAt: "2030-01-01T00:00:00.000Z", reason: null }),
    stopLocalCollaborationServer: vi.fn().mockResolvedValue({ profile: null, state: "stopped", startedAt: null, reason: null }),
    listLocalCollaborationTrustedScopes: vi.fn().mockResolvedValue([{ workspaceId: "workspace-1", projectId: "project-1", canvasId: "canvas-1" }]),
    registerLocalCollaborationCurrentProject: vi.fn().mockResolvedValue({ workspaceId: "workspace-1", projectId: "project-1", canvasId: "canvas-1", profileId: profile.profileId, registeredAt: "2030-01-01T00:00:01.000Z" }),
    ...overrides
  } as PlanWeaveCollaborationApi;
}

describe("LocalCollaborationServerPanel", () => {
  it("starts, loads trusted scopes, and registers the current canvas", async () => {
    const collaborationApi = api({
      getLocalCollaborationServerStatus: vi
        .fn()
        .mockResolvedValueOnce({ profile: null, state: "stopped", startedAt: null, reason: null })
        .mockResolvedValue({ profile, state: "running", startedAt: "2030-01-01T00:00:00.000Z", reason: null })
    });
    render(<LocalCollaborationServerPanel api={collaborationApi} t={createTranslator("en")} />);
    await userEvent.click(await screen.findByRole("button", { name: "Start local server" }));
    await waitFor(() => expect(collaborationApi.listLocalCollaborationTrustedScopes).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "Register current canvas" }));
    await waitFor(() => expect(collaborationApi.registerLocalCollaborationCurrentProject).toHaveBeenCalled());
    expect(screen.getByText(/Registered:/)).toHaveTextContent("2030-01-01T00:00:01.000Z");
  });

  it("explains when registration requires owner initialization", async () => {
    const collaborationApi = api({
      getLocalCollaborationServerStatus: vi.fn().mockResolvedValue({ profile, state: "running", startedAt: "2030-01-01T00:00:00.000Z", reason: null }),
      registerLocalCollaborationCurrentProject: vi.fn().mockRejectedValue(new Error("local_collaboration_owner_initialization_required"))
    });
    render(<LocalCollaborationServerPanel api={collaborationApi} t={createTranslator("en")} />);
    await userEvent.click(await screen.findByRole("button", { name: "Register current canvas" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Initialize an owner before registering the current canvas.");
  });
});
