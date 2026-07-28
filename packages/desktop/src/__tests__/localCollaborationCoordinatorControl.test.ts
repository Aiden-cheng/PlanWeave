import type { DesktopProjectSummary } from "@planweave-ai/runtime";
import {
  loopbackServerLifecycleRequestSchema,
  type LoopbackProjectRegistrationView,
  type LoopbackServerStatus,
  type LoopbackTrustedProjectScope
} from "@planweave-ai/collaboration-contracts";
import { describe, expect, it, vi } from "vitest";
import { LocalCollaborationCoordinatorControl } from "../main/collaboration/CollaborationCoordinatorControl";

const project: DesktopProjectSummary = {
  projectId: "project-1",
  name: "Project",
  kind: "external",
  rootPath: "/test/project",
  sourceRoot: "/test/project",
  workspaceRoot: "/test/project",
  activeCanvasId: "canvas-1",
  taskCanvases: [
    {
      canvasId: "canvas-1",
      name: "Canvas",
      packageDir: null,
      executionPolicy: null,
      taskCount: 0,
      missingPromptCount: 0,
      diagnostics: [],
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z"
    }
  ]
};

const nextProject: DesktopProjectSummary = {
  ...project,
  projectId: "project-2",
  rootPath: "/test/next-project",
  sourceRoot: "/test/next-project",
  workspaceRoot: "/test/next-project"
};

const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => Buffer.alloc(0),
  decryptString: () => ""
};

function fakeControl(options: {
  scopes?: readonly LoopbackTrustedProjectScope[];
  pauseStop?: boolean;
} = {}) {
  let status: LoopbackServerStatus = {
    profile: null,
    state: "stopped",
    startedAt: null,
    reason: null
  };
  const scopes = options.scopes ?? [
    { workspaceId: "workspace-2", projectId: "project-1", canvasId: "canvas-1" }
  ];
  let releaseStop: (() => void) | null = null;
  const stopGate = options.pauseStop
    ? new Promise<void>((resolve) => {
        releaseStop = resolve;
      })
    : Promise.resolve();
  const apply = vi.fn(async (input: unknown) => {
    const request = loopbackServerLifecycleRequestSchema.parse(input);
    if (request.action === "start") {
      status = {
        profile: request.profile,
        state: "running",
        startedAt: "2030-01-01T00:00:00.000Z",
        reason: null
      };
      return status;
    }
    await stopGate;
    status = { profile: null, state: "stopped", startedAt: null, reason: null };
    return status;
  });
  const registerTrustedProject = vi.fn(
    (_actor: { kind: "human"; id: string }, request: {
      workspaceId: string;
      projectId: string;
      canvasId: string;
      profileId: string;
    }): LoopbackProjectRegistrationView => ({
      ...request,
      registeredAt: "2030-01-01T00:00:01.000Z"
    })
  );
  return {
    apply,
    releaseStop: () => releaseStop?.(),
    registerTrustedProject,
    control: {
      status: () => status,
      apply,
      listTrustedProjectScopes: () => scopes,
      registerTrustedProject
    }
  };
}

describe("LocalCollaborationCoordinatorControl", () => {
  it("resolves opaque selection, registers its exact trusted scope, and waits for clear stop", async () => {
    const fake = fakeControl({ pauseStop: true });
    const assertCanvasWorkspace = vi.fn().mockResolvedValue(undefined);
    const control = new LocalCollaborationCoordinatorControl({
      safeStorage,
      projects: { listProjects: async () => [project], assertCanvasWorkspace },
      createController: () => fake.control
    });

    await control.setCurrentSelection({ projectId: project.projectId, canvasId: "canvas-1" });
    await control.start();
    expect(control.listActiveTrustedScopes()).toEqual([
      { workspaceId: "workspace-2", projectId: "project-1", canvasId: "canvas-1" }
    ]);
    expect(control.registerCurrentProject({ kind: "human", id: "owner-1" })).toMatchObject({
      workspaceId: "workspace-2",
      projectId: "project-1",
      canvasId: "canvas-1"
    });
    expect(fake.registerTrustedProject).toHaveBeenCalledWith(
      { kind: "human", id: "owner-1" },
      expect.objectContaining({ workspaceId: "workspace-2", projectId: "project-1", canvasId: "canvas-1" })
    );

    const clear = control.clearCurrentSelection();
    expect(fake.apply).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "stop", profileId: "planweave-local-loopback" })
    );
    expect(control.status().state).toBe("running");
    fake.releaseStop();
    await clear;
    expect(control.status().state).toBe("stopped");
    expect(assertCanvasWorkspace).toHaveBeenCalledWith("/test/project", "canvas-1");
  });

  it("rejects unknown, ambiguous, or duplicate trusted opaque selections", async () => {
    const duplicateScope = { workspaceId: "workspace-3", projectId: "project-1", canvasId: "canvas-1" };
    const fake = fakeControl({
      scopes: [
        { workspaceId: "workspace-2", projectId: "project-1", canvasId: "canvas-1" },
        duplicateScope
      ]
    });
    const control = new LocalCollaborationCoordinatorControl({
      safeStorage,
      projects: { listProjects: async () => [project, project], assertCanvasWorkspace: async () => undefined },
      createController: () => fake.control
    });

    await expect(
      control.setCurrentSelection({ projectId: project.projectId, canvasId: "canvas-1" })
    ).rejects.toThrow("local_collaboration_project_selection_ambiguous");
    await expect(
      control.setCurrentSelection({ projectId: "unknown", canvasId: "canvas-1" })
    ).rejects.toThrow("local_collaboration_project_selection_ambiguous");

    const unambiguousControl = new LocalCollaborationCoordinatorControl({
      safeStorage,
      projects: { listProjects: async () => [project], assertCanvasWorkspace: async () => undefined },
      createController: () => fake.control
    });
    await unambiguousControl.setCurrentSelection({ projectId: project.projectId, canvasId: "canvas-1" });
    await unambiguousControl.start();
    expect(() => unambiguousControl.registerCurrentProject({ kind: "human", id: "owner-1" })).toThrow(
      "local_collaboration_trusted_scope_ambiguous"
    );
  });

  it("waits for the active local server to stop before switching selections", async () => {
    const fake = fakeControl({ pauseStop: true });
    const assertCanvasWorkspace = vi.fn().mockResolvedValue(undefined);
    const control = new LocalCollaborationCoordinatorControl({
      safeStorage,
      projects: {
        listProjects: async () => [project, nextProject],
        assertCanvasWorkspace
      },
      createController: () => fake.control
    });
    await control.setCurrentSelection({ projectId: project.projectId, canvasId: "canvas-1" });
    await control.start();

    const switchSelection = control.setCurrentSelection({
      projectId: nextProject.projectId,
      canvasId: "canvas-1"
    });
    await vi.waitFor(() => {
      expect(fake.apply).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: "stop", profileId: "planweave-local-loopback" })
      );
    });
    expect(control.localProfile()?.projectId).toBe(project.projectId);
    fake.releaseStop();
    await switchSelection;

    expect(control.localProfile()?.projectId).toBe(nextProject.projectId);
    expect(assertCanvasWorkspace).toHaveBeenLastCalledWith("/test/next-project", "canvas-1");
  });
});
