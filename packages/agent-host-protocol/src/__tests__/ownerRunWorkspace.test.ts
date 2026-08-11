import { describe, expect, it } from "vitest";
import {
  OwnerRunWorkspaceResolverError,
  ownerPackageLocatorForRun,
  resolveOwnerRunWorkspace
} from "../ownerRunWorkspace.js";
import { ownerPackageLocatorSchema } from "../ownerPackageLocator.js";

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

  it("resolves roots with repeated trailing separators in linear time", () => {
    const resolved = resolveOwnerRunWorkspace({
      workspaceRoot: `/var/agent-host/workspaces${"/".repeat(10_000)}`,
      locator: ownerPackageLocatorForRun({ projectId: "p", canvasId: "c" })
    });
    expect(resolved.absolutePath).toBe("/var/agent-host/workspaces/fleet-runs/p/c");
  });

  it("rejects absolute package paths on POSIX and Windows", () => {
    for (const relativePackagePath of ["/srv/package", "C:/package", "C:\\package"]) {
      expect(() =>
        ownerPackageLocatorSchema.parse({
          strategy: "host_relative_package",
          relativePackagePath
        })
      ).toThrow();
    }
  });
});
