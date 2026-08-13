import { describe, expect, it } from "vitest";
import { collaborationSurfaceCanvasIdForView } from "../renderer/ProjectWorkspaceProvider";
import { resolveCollaborationSurfaceReadBinding } from "../renderer/hooks/useCollaborationSurface";

describe("project workspace collaboration scope", () => {
  it("keeps the Members route global when a private sidebar canvas is selected", () => {
    expect(collaborationSurfaceCanvasIdForView("people", "private-canvas")).toBeNull();
  });

  it("keeps canvas filtering for canvas-scoped application routes", () => {
    expect(collaborationSurfaceCanvasIdForView("graph", "shared-canvas")).toBe("shared-canvas");
  });

  it("does not bind remote assignment reads to a different local project", () => {
    expect(
      resolveCollaborationSurfaceReadBinding({
        sessionConnected: true,
        profileId: "profile-1",
        profileProjectId: "tiny-notes",
        localProjectId: "planweave",
        canvasId: "default"
      })
    ).toEqual({ profileId: null, projectId: null, canvasId: null });
  });

  it("keeps same-project assignment reads scoped to the selected canvas", () => {
    expect(
      resolveCollaborationSurfaceReadBinding({
        sessionConnected: true,
        profileId: "profile-1",
        profileProjectId: "planweave",
        localProjectId: "planweave",
        canvasId: "default"
      })
    ).toEqual({ profileId: "profile-1", projectId: "planweave", canvasId: "default" });
  });
});
