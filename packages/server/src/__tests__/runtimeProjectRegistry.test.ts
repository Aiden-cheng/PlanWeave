import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { createTrustedRuntimeRegistry } from "../runtimeProjectRegistry.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("createTrustedRuntimeRegistry", () => {
  it("binds only an explicitly configured project identity", async () => {
    const workspace = await createTestWorkspace(basicManifest());
    directories.push(workspace.home, workspace.root);
    await expect(
      createTrustedRuntimeRegistry([
        { projectId: "wrong-project", canvasId: "default", projectRoot: workspace.root }
      ])
    ).rejects.toThrow("trusted_project_identity_mismatch");

    const locator = { projectId: workspace.init.workspace.id, canvasId: "default" };
    const trusted = await createTrustedRuntimeRegistry([
      { ...locator, projectRoot: workspace.root }
    ]);
    expect(trusted.locators).toEqual([locator]);
    expect(trusted.hasProject(locator.projectId)).toBe(true);
    expect(trusted.hasProject("unknown-project")).toBe(false);
    expect(trusted.hasCanvas(locator.projectId, locator.canvasId)).toBe(true);
    expect(trusted.hasCanvas(locator.projectId, "unknown-canvas")).toBe(false);
    expect(trusted.hasCanvas("unknown-project", locator.canvasId)).toBe(false);
    trusted.locators.push({ projectId: "unknown-project", canvasId: "default" });
    expect(trusted.hasProject("unknown-project")).toBe(false);
    expect(trusted.hasCanvas("unknown-project", "default")).toBe(false);
    expect(() => trusted.registry.resolve(locator)).not.toThrow();
    trusted.close();
    expect(() => trusted.registry.resolve(locator)).toThrow("remote_runtime_locator_unresolved");
  });
});
