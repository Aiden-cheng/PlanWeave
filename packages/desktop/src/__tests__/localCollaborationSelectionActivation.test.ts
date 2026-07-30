import { describe, expect, it, vi } from "vitest";
import { activateLocalCollaborationSelection } from "../main/collaboration/localCollaborationSelectionActivation.js";

const profile = {
  profileId: "planweave-local-project",
  displayName: "Local collaboration server",
  serverBaseUrl: "http://127.0.0.1:8787/",
  projectId: "project-1",
  allowInsecureTransport: true
};

describe("activateLocalCollaborationSelection", () => {
  it("re-registers a trusted canvas before reconnecting a persisted owner", async () => {
    const calls: string[] = [];
    const coordinator = {
      localProfile: vi.fn(() => profile),
      registerCurrentProject: vi.fn(() => {
        calls.push("register");
        return {
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: "canvas-1",
          profileId: profile.profileId,
          registeredAt: "2030-01-01T00:00:00.000Z"
        };
      })
    };
    const service = {
      upsertProfile: vi.fn(async () => undefined),
      migrateLocalProfileCredential: vi.fn(async () => undefined),
      setActiveProfile: vi.fn(async () => undefined),
      activeHumanPrincipalId: vi.fn(async () => "human-owner"),
      bootstrapOwner: vi.fn(async () => {
        throw new Error("bootstrap must not run for a persisted owner");
      }),
      connectSession: vi.fn(async () => {
        calls.push("connect");
      })
    };

    const registration = await activateLocalCollaborationSelection({
      coordinator,
      service,
      ownerDisplayName: "Local owner"
    });

    expect(registration).toEqual(expect.objectContaining({ projectId: "project-1" }));
    expect(calls).toEqual(["register", "connect"]);
    expect(coordinator.registerCurrentProject).toHaveBeenCalledWith({
      kind: "human",
      id: "human-owner"
    });
  });

  it("initializes the local owner once and continues activation automatically", async () => {
    const coordinator = {
      localProfile: vi.fn(() => profile),
      registerCurrentProject: vi.fn(() => ({
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "canvas-1",
        profileId: profile.profileId,
        registeredAt: "2030-01-01T00:00:00.000Z"
      }))
    };
    const service = {
      upsertProfile: vi.fn(async () => undefined),
      migrateLocalProfileCredential: vi.fn(async () => undefined),
      setActiveProfile: vi.fn(async () => undefined),
      activeHumanPrincipalId: vi.fn(async () => null),
      bootstrapOwner: vi.fn(async () => ({
        principal: { humanPrincipalId: "human-new-owner" }
      })),
      connectSession: vi.fn(async () => undefined)
    };

    await activateLocalCollaborationSelection({
      coordinator,
      service,
      ownerDisplayName: "Local owner"
    });

    expect(service.bootstrapOwner).toHaveBeenCalledWith({
      profileId: profile.profileId,
      request: { displayName: "Local owner" }
    });
    expect(coordinator.registerCurrentProject).toHaveBeenCalledWith({
      kind: "human",
      id: "human-new-owner"
    });
    expect(service.connectSession).toHaveBeenCalledWith({ profileId: profile.profileId });
  });
});
