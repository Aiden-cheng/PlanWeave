import { describe, expect, it } from "vitest";
import {
  OwnerRunWorkspaceResolverError,
  ownerPackageLocatorForRun,
  resolveOwnerRunWorkspace
} from "../ownerRunWorkspace.js";

describe("ownerRunWorkspace", () => {
  it("D1: resolves host_relative_package under workspace root", () => {
    const locator = ownerPackageLocatorForRun({
      projectId: "project-a",
      canvasId: "canvas-main"
    });
    const resolved = resolveOwnerRunWorkspace({
      workspaceRoot: "/var/agent-host/workspaces",
      locator
    });
    expect(resolved.absolutePath).toBe(
      "/var/agent-host/workspaces/fleet-runs/project-a/canvas-main"
    );
  });

  it("D1: rejects missing workspace root", () => {
    expect(() =>
      resolveOwnerRunWorkspace({
        workspaceRoot: "relative/path",
        locator: ownerPackageLocatorForRun({ projectId: "p", canvasId: "c" })
      })
    ).toThrow(OwnerRunWorkspaceResolverError);
  });
});
