import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("supports an empty collaboration runtime registry", async () => {
    const trusted = await createTrustedRuntimeRegistry([]);

    expect(trusted.expansions).toEqual([]);
    expect(trusted.locators).toEqual([]);
    expect(trusted.hasProject("project-1")).toBe(false);
    trusted.close();
  });

  it("binds only an explicitly configured project identity", async () => {
    const workspace = await createTestWorkspace(basicManifest());
    directories.push(workspace.home, workspace.root);
    await expect(
      createTrustedRuntimeRegistry([
        {
          workspaceId: "workspace-one",
          projectId: "wrong-project",
          canvasId: "default",
          projectRoot: workspace.root
        }
      ])
    ).rejects.toThrow("trusted_project_identity_mismatch");

    const locator = {
      workspaceId: "workspace-one",
      projectId: workspace.init.workspace.id,
      canvasId: "default"
    };
    const trusted = await createTrustedRuntimeRegistry([
      { ...locator, projectRoot: workspace.root }
    ]);
    expect(trusted.locators).toEqual([locator]);
    expect(trusted.hasScope(locator)).toBe(true);
    expect(trusted.hasProject("unknown-project")).toBe(false);
    expect(trusted.hasScope(locator)).toBe(true);
    expect(trusted.hasCanvas(locator.projectId, "unknown-canvas")).toBe(false);
    expect(trusted.hasCanvas("unknown-project", locator.canvasId)).toBe(false);
    trusted.locators.push({
      workspaceId: "workspace-unknown",
      projectId: "unknown-project",
      canvasId: "default"
    });
    expect(trusted.hasProject("unknown-project")).toBe(false);
    expect(trusted.hasCanvas("unknown-project", "default")).toBe(false);
    expect(() => trusted.registry.resolve(locator)).not.toThrow();
    trusted.close();
    expect(() => trusted.registry.resolve(locator)).toThrow("remote_runtime_locator_unresolved");
  });

  it("treats an installed scoped package resolver as authoritative", async () => {
    const workspace = await createTestWorkspace(basicManifest());
    directories.push(workspace.home, workspace.root);
    const locator = {
      workspaceId: "workspace-one",
      projectId: workspace.init.workspace.id,
      canvasId: "default"
    };
    const trusted = await createTrustedRuntimeRegistry([
      { ...locator, projectRoot: workspace.root }
    ]);
    const scope = locator;

    expect(trusted.scopedWorkItemPackagePort(scope)).toBeDefined();
    trusted.setScopedPackageResolver(() => undefined);
    expect(trusted.scopedWorkItemPackagePort(scope)).toBeUndefined();
    expect(trusted.acquireScopedWorkItemPackagePort(scope)).toBeUndefined();
    trusted.close();
  });

  it("keeps identical project and canvas IDs isolated by Workspace scope", async () => {
    const workspace = await createTestWorkspace(basicManifest());
    directories.push(workspace.home, workspace.root);
    const projectId = workspace.init.workspace.id;
    const trusted = await createTrustedRuntimeRegistry([
      {
        workspaceId: "workspace-a",
        projectId,
        canvasId: "default",
        projectRoot: workspace.root
      },
      {
        workspaceId: "workspace-b",
        projectId,
        canvasId: "default",
        projectRoot: workspace.root
      }
    ]);

    expect(trusted.hasScope({ workspaceId: "workspace-a", projectId, canvasId: "default" })).toBe(
      true
    );
    expect(trusted.hasScope({ workspaceId: "workspace-b", projectId, canvasId: "default" })).toBe(
      true
    );
    expect(trusted.hasCanvas(projectId, "default")).toBe(false);
    expect(() =>
      trusted.registry.resolve({ workspaceId: "workspace-missing", projectId, canvasId: "default" })
    ).toThrow("remote_runtime_locator_unresolved");
    expect(() =>
      trusted.registry.resolve({ workspaceId: "workspace-a", projectId, canvasId: "default" })
    ).not.toThrow();
    expect(() =>
      trusted.registry.resolve({ workspaceId: "workspace-b", projectId, canvasId: "default" })
    ).not.toThrow();
    trusted.close();
  });

  it("acquires and releases scoped runtime and artifact bindings", async () => {
    const workspace = await createTestWorkspace(basicManifest());
    directories.push(workspace.home, workspace.root);
    const locator = {
      workspaceId: "workspace-one",
      projectId: workspace.init.workspace.id,
      canvasId: "default"
    };
    const trusted = await createTrustedRuntimeRegistry([
      { ...locator, projectRoot: workspace.root }
    ]);
    const runtime = trusted.registry.resolve(locator);
    const artifacts = trusted.registry.resolveArtifactSource(locator);
    const release = vi.fn();
    const resolveScoped = vi.fn(() => ({ runtime, artifacts, release }));
    trusted.registry.setScopedResolver(resolveScoped);

    const runtimeHandle = await trusted.registry.acquire({
      projectId: locator.projectId,
      canvasId: "dynamically-registered"
    });
    expect(runtimeHandle.runtime).toBe(runtime);
    runtimeHandle.release();
    runtimeHandle.release();
    const artifactHandle = await trusted.registry.acquireArtifactSource(locator);
    expect(artifactHandle.source).toBe(artifacts);
    artifactHandle.release();

    expect(resolveScoped).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    trusted.close();
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
      {
        workspaceId: "workspace-one",
        projectId,
        projectRoot: workspace.root,
        trustAllDeclaredCanvases: true
      }
    ]);
    expect(trusted.locators).toEqual([
      { workspaceId: "workspace-one", projectId, canvasId: "default" },
      { workspaceId: "workspace-one", projectId, canvasId: "secondary" }
    ]);
    expect(trusted.expansions).toEqual([
      expect.objectContaining({
        projectId,
        workspaceId: "workspace-one",
        projectRoot: workspace.root,
        canvasId: "default",
        packageDir: workspace.init.workspace.packageDir
      }),
      expect.objectContaining({ projectId, canvasId: "secondary" })
    ]);
    expect(Object.isFrozen(trusted.expansions)).toBe(true);
    expect(Object.isFrozen(trusted.expansions[0])).toBe(true);
    expect(
      trusted.hasScope({ workspaceId: "workspace-one", projectId, canvasId: "secondary" })
    ).toBe(true);
    expect(trusted.hasCanvas(projectId, "undeclared")).toBe(false);
    expect(() =>
      trusted.registry.resolve({ workspaceId: "workspace-one", projectId, canvasId: "secondary" })
    ).not.toThrow();
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
      { workspaceId: "workspace-one", projectId, projectRoot: workspace.root, canvasId: "default" }
    ]);
    expect(trusted.locators).toEqual([
      { workspaceId: "workspace-one", projectId, canvasId: "default" }
    ]);
    expect(trusted.hasCanvas(projectId, "default")).toBe(true);
    expect(trusted.hasCanvas(projectId, "secondary")).toBe(false);
    expect(() =>
      trusted.registry.resolve({ workspaceId: "workspace-one", projectId, canvasId: "secondary" })
    ).toThrow("remote_runtime_locator_unresolved");
    trusted.close();
  });

  it("rejects a legacy canvas hint that is not declared by Runtime", async () => {
    const workspace = await createTestWorkspace(basicManifest());
    directories.push(workspace.home, workspace.root);
    await expect(
      createTrustedRuntimeRegistry([
        {
          workspaceId: "workspace-one",
          projectId: workspace.init.workspace.id,
          projectRoot: workspace.root,
          canvasId: "missing"
        }
      ])
    ).rejects.toThrow("trusted_project_canvas_not_declared");
  });
});
