import { describe, expect, it, vi } from "vitest";
import {
  activateLocalCollaborationSelection,
  createLocalCollaborationActivationCommand
} from "../main/collaboration/localCollaborationSelectionActivation.js";

const profile = {
  profileId: "planweave-local-project",
  displayName: "Local collaboration server",
  serverBaseUrl: "http://127.0.0.1:8787/",
  projectId: "project-1",
  allowInsecureTransport: true
};

describe("activateLocalCollaborationSelection", () => {
  it("clears a stale local profile when a cold-start selection is not trusted", async () => {
    const coordinator = {
      currentSelection: vi.fn(() => null),
      status: vi.fn(() => ({ state: "running" })),
      currentSelectionIsTrusted: vi.fn(() => false),
      setCurrentSelection: vi.fn(async () => undefined),
      clearCurrentSelection: vi.fn(async () => undefined),
      localProfile: vi.fn(() => null),
      ownsLocalProfile: vi.fn((profileId: string) => profileId === "planweave-local-tiny"),
      registerCurrentProject: vi.fn()
    };
    const service = {
      getStatus: vi.fn(async () => ({
        activeProfileId: "planweave-local-tiny",
        session: { phase: "idle" }
      })),
      runStatusPublicationTransaction: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
      clearActiveProfile: vi.fn(async () => undefined),
      setActiveProfile: vi.fn(),
      connectSession: vi.fn(),
      upsertProfile: vi.fn(),
      migrateLocalProfileCredential: vi.fn(),
      activeHumanPrincipalId: vi.fn(),
      bootstrapOwner: vi.fn()
    };

    const command = createLocalCollaborationActivationCommand({ coordinator, service });
    await command.selectAndReconcile({ projectId: "desktop-apollo", canvasId: "default" });

    expect(service.clearActiveProfile).toHaveBeenCalledOnce();
  });

  it("preserves a remote profile when the selected local project is not trusted", async () => {
    const coordinator = {
      currentSelection: vi.fn(() => null),
      status: vi.fn(() => ({ state: "running" })),
      currentSelectionIsTrusted: vi.fn(() => false),
      setCurrentSelection: vi.fn(async () => undefined),
      clearCurrentSelection: vi.fn(async () => undefined),
      localProfile: vi.fn(() => null),
      ownsLocalProfile: vi.fn(() => false),
      registerCurrentProject: vi.fn()
    };
    const service = {
      getStatus: vi.fn(async () => ({
        activeProfileId: "remote-team",
        session: { phase: "connected" }
      })),
      runStatusPublicationTransaction: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
      clearActiveProfile: vi.fn(async () => undefined),
      setActiveProfile: vi.fn(),
      connectSession: vi.fn(),
      upsertProfile: vi.fn(),
      migrateLocalProfileCredential: vi.fn(),
      activeHumanPrincipalId: vi.fn(),
      bootstrapOwner: vi.fn()
    };

    const command = createLocalCollaborationActivationCommand({ coordinator, service });
    await command.selectAndReconcile({ projectId: "desktop-apollo", canvasId: "default" });

    expect(service.clearActiveProfile).not.toHaveBeenCalled();
  });

  it("changes the selected canvas without clearing the active collaboration profile", async () => {
    const calls: string[] = [];
    const coordinator = {
      currentSelection: vi.fn(() => null),
      status: vi.fn(() => ({ state: "running" })),
      currentSelectionIsTrusted: vi.fn(() => true),
      ownsLocalProfile: vi.fn(() => true),
      setCurrentSelection: vi.fn(async () => {
        calls.push("select");
      }),
      clearCurrentSelection: vi.fn(async () => undefined),
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
      upsertProfile: vi.fn(async () => {
        calls.push("upsert");
      }),
      migrateLocalProfileCredential: vi.fn(async () => undefined),
      setActiveProfile: vi.fn(async () => undefined),
      activeHumanPrincipalId: vi.fn(async () => "human-owner"),
      bootstrapOwner: vi.fn(async () => {
        throw new Error("bootstrap must not run for a persisted owner");
      }),
      connectSession: vi.fn(async () => {
        calls.push("connect");
      }),
      clearActiveProfile: vi.fn(async () => undefined),
      getStatus: vi.fn(async () => ({
        activeProfileId: profile.profileId,
        session: { phase: "connected" }
      })),
      runStatusPublicationTransaction: vi.fn(async <T>(operation: () => Promise<T>) => operation())
    };

    const command = createLocalCollaborationActivationCommand({ coordinator, service });
    await command.selectAndReconcile({
      projectId: "desktop-project-1",
      canvasId: "canvas-1"
    });

    expect(calls).toEqual(["select", "upsert", "register", "connect"]);
    expect(coordinator.setCurrentSelection).toHaveBeenCalledOnce();
  });

  it("re-registers a trusted canvas before reconnecting a persisted owner", async () => {
    const calls: string[] = [];
    const coordinator = {
      setCurrentSelection: vi.fn(async () => undefined),
      clearCurrentSelection: vi.fn(async () => undefined),
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
      }),
      clearActiveProfile: vi.fn(async () => undefined)
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
      setCurrentSelection: vi.fn(async () => undefined),
      clearCurrentSelection: vi.fn(async () => undefined),
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
      connectSession: vi.fn(async () => undefined),
      clearActiveProfile: vi.fn(async () => undefined)
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

  it("restores the previous stable selection and profile when activation fails", async () => {
    const previousSelection = { projectId: "desktop-project-1", canvasId: "canvas-stable" };
    const nextSelection = { projectId: "desktop-project-1", canvasId: "canvas-next" };
    let currentSelection = previousSelection;
    const coordinator = {
      currentSelection: vi.fn(() => currentSelection),
      status: vi.fn(() => ({ state: "running" })),
      currentSelectionIsTrusted: vi.fn(() => true),
      ownsLocalProfile: vi.fn(() => false),
      setCurrentSelection: vi.fn(async (selection: typeof previousSelection) => {
        currentSelection = selection;
      }),
      clearCurrentSelection: vi.fn(async () => {
        throw new Error("a previous stable selection must not be cleared");
      }),
      localProfile: vi.fn(() => profile),
      registerCurrentProject: vi.fn(() => {
        throw new Error("registration_failed");
      })
    };
    const service = {
      upsertProfile: vi.fn(async () => undefined),
      migrateLocalProfileCredential: vi.fn(async () => undefined),
      setActiveProfile: vi.fn(async () => undefined),
      activeHumanPrincipalId: vi.fn(async () => "human-owner"),
      bootstrapOwner: vi.fn(async () => ({
        principal: { humanPrincipalId: "human-owner" }
      })),
      connectSession: vi.fn(async () => undefined),
      clearActiveProfile: vi.fn(async () => undefined),
      getStatus: vi.fn(async () => ({
        activeProfileId: "profile-stable",
        session: { phase: "connected" }
      })),
      runStatusPublicationTransaction: vi.fn(async <T>(operation: () => Promise<T>) => operation())
    };

    const command = createLocalCollaborationActivationCommand({ coordinator, service });

    await expect(
      command.activate({
        selection: nextSelection,
        ownerDisplayName: "Local owner"
      })
    ).rejects.toThrow("registration_failed");

    expect(currentSelection).toEqual(previousSelection);
    expect(service.setActiveProfile).toHaveBeenLastCalledWith({ profileId: "profile-stable" });
    expect(service.connectSession).toHaveBeenLastCalledWith({ profileId: "profile-stable" });
    expect(service.clearActiveProfile).not.toHaveBeenCalled();
  });

  it("serializes overlapping local activation commands", async () => {
    const calls: string[] = [];
    let releaseFirstSelection!: () => void;
    const firstSelectionBlocked = new Promise<void>((resolve) => {
      releaseFirstSelection = resolve;
    });
    let selectedCanvasId = "canvas-stable";
    const coordinator = {
      currentSelection: vi.fn(() => ({
        projectId: "desktop-project-1",
        canvasId: selectedCanvasId
      })),
      status: vi.fn(() => ({ state: "running" })),
      currentSelectionIsTrusted: vi.fn(() => true),
      ownsLocalProfile: vi.fn(() => true),
      setCurrentSelection: vi.fn(async (selection: { projectId: string; canvasId: string }) => {
        selectedCanvasId = selection.canvasId;
        calls.push(`select:${selection.canvasId}`);
        if (selection.canvasId === "canvas-first") await firstSelectionBlocked;
      }),
      clearCurrentSelection: vi.fn(async () => undefined),
      localProfile: vi.fn(() => ({ ...profile, projectId: selectedCanvasId })),
      registerCurrentProject: vi.fn(() => {
        calls.push(`register:${selectedCanvasId}`);
        return {
          workspaceId: "workspace-1",
          projectId: selectedCanvasId,
          canvasId: selectedCanvasId,
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
        calls.push(`connect:${selectedCanvasId}`);
      }),
      clearActiveProfile: vi.fn(async () => undefined),
      getStatus: vi.fn(async () => ({
        activeProfileId: profile.profileId,
        session: { phase: "connected" }
      })),
      runStatusPublicationTransaction: vi.fn(async <T>(operation: () => Promise<T>) => operation())
    };
    const command = createLocalCollaborationActivationCommand({ coordinator, service });

    const first = command.activate({
      selection: { projectId: "desktop-project-1", canvasId: "canvas-first" }
    });
    await vi.waitFor(() => expect(calls).toEqual(["select:canvas-first"]));
    const second = command.activate({
      selection: { projectId: "desktop-project-1", canvasId: "canvas-second" }
    });
    await Promise.resolve();
    expect(calls).toEqual(["select:canvas-first"]);

    releaseFirstSelection();
    await Promise.all([first, second]);
    expect(calls).toEqual([
      "select:canvas-first",
      "register:canvas-first",
      "connect:canvas-first",
      "select:canvas-second",
      "register:canvas-second",
      "connect:canvas-second"
    ]);
  });
});
