import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  basicManifest,
  createTestWorkspace,
  writePromptFiles
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import {
  canonicalProjectCanvasNode,
  loadProjectGraph,
  projectCanvasWorkspace,
  writeProjectGraph
} from "../../../runtime/src/projectGraph/index.js";
import { writeJsonFile } from "../../../runtime/src/json.js";
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

  it("expands every Runtime-declared canvas from one trusted project root", async () => {
    const workspace = await createTestWorkspace(basicManifest());
    directories.push(workspace.home, workspace.root);
    const loaded = await loadProjectGraph(workspace.root);
    const secondaryCanvas = canonicalProjectCanvasNode({
      id: "secondary",
      title: "Secondary canvas"
    });
    const secondaryWorkspace = projectCanvasWorkspace(loaded.workspace, secondaryCanvas);
    await mkdir(secondaryWorkspace.packageDir, { recursive: true });
    await writeJsonFile(secondaryWorkspace.manifestFile, basicManifest());
    await writePromptFiles(secondaryWorkspace.packageDir, basicManifest());
    await mkdir(secondaryWorkspace.resultsDir, { recursive: true });
    await mkdir(join(loaded.workspace.workspaceRoot, "canvases", "undeclared"), {
      recursive: true
    });
    await writeProjectGraph(loaded.workspace, {
      version: "plan-project/v1",
      canvases: [
        canonicalProjectCanvasNode({ id: "default", title: "Default canvas" }),
        secondaryCanvas
      ],
      edges: [],
      crossTaskEdges: []
    });

    const projectId = workspace.init.workspace.id;
    const trusted = await createTrustedRuntimeRegistry([
      { projectId, projectRoot: workspace.root, trustAllDeclaredCanvases: true }
    ]);
    expect(trusted.locators).toEqual([
      { projectId, canvasId: "default" },
      { projectId, canvasId: "secondary" }
    ]);
    expect(trusted.expansions).toEqual([
      expect.objectContaining({
        projectId,
        projectRoot: workspace.root,
        canvasId: "default",
        packageDir: workspace.init.workspace.packageDir
      }),
      expect.objectContaining({ projectId, canvasId: "secondary" })
    ]);
    expect(Object.isFrozen(trusted.expansions)).toBe(true);
    expect(Object.isFrozen(trusted.expansions[0])).toBe(true);
    expect(trusted.hasCanvas(projectId, "secondary")).toBe(true);
    expect(trusted.hasCanvas(projectId, "undeclared")).toBe(false);
    expect(() => trusted.registry.resolve({ projectId, canvasId: "secondary" })).not.toThrow();
    trusted.close();
  });

  it("keeps legacy canvas trust scoped to the configured canvas", async () => {
    const workspace = await createTestWorkspace(basicManifest());
    directories.push(workspace.home, workspace.root);
    const loaded = await loadProjectGraph(workspace.root);
    const secondaryCanvas = canonicalProjectCanvasNode({
      id: "secondary",
      title: "Secondary canvas"
    });
    const secondaryWorkspace = projectCanvasWorkspace(loaded.workspace, secondaryCanvas);
    await mkdir(secondaryWorkspace.packageDir, { recursive: true });
    await writeJsonFile(secondaryWorkspace.manifestFile, basicManifest());
    await writePromptFiles(secondaryWorkspace.packageDir, basicManifest());
    await mkdir(secondaryWorkspace.resultsDir, { recursive: true });
    await writeProjectGraph(loaded.workspace, {
      version: "plan-project/v1",
      canvases: [
        canonicalProjectCanvasNode({ id: "default", title: "Default canvas" }),
        secondaryCanvas
      ],
      edges: [],
      crossTaskEdges: []
    });

    const projectId = workspace.init.workspace.id;
    const trusted = await createTrustedRuntimeRegistry([
      { projectId, projectRoot: workspace.root, canvasId: "default" }
    ]);
    expect(trusted.locators).toEqual([{ projectId, canvasId: "default" }]);
    expect(trusted.hasCanvas(projectId, "default")).toBe(true);
    expect(trusted.hasCanvas(projectId, "secondary")).toBe(false);
    expect(() => trusted.registry.resolve({ projectId, canvasId: "secondary" })).toThrow(
      "remote_runtime_locator_unresolved"
    );
    trusted.close();
  });

  it("rejects a legacy canvas hint that is not declared by Runtime", async () => {
    const workspace = await createTestWorkspace(basicManifest());
    directories.push(workspace.home, workspace.root);
    await expect(
      createTrustedRuntimeRegistry([
        {
          projectId: workspace.init.workspace.id,
          projectRoot: workspace.root,
          canvasId: "missing"
        }
      ])
    ).rejects.toThrow("trusted_project_canvas_not_declared");
  });
});
