import { describe, expect, it } from "vitest";
import { collaborationSurfaceCanvasIdForView } from "../renderer/ProjectWorkspaceProvider";

describe("project workspace collaboration scope", () => {
  it("keeps the Members route global when a private sidebar canvas is selected", () => {
    expect(collaborationSurfaceCanvasIdForView("people", "private-canvas")).toBeNull();
  });

  it("keeps canvas filtering for canvas-scoped application routes", () => {
    expect(collaborationSurfaceCanvasIdForView("graph", "shared-canvas")).toBe("shared-canvas");
  });
});
