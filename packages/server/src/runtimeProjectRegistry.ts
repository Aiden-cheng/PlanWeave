import {
  createRemoteBlockArtifactSource,
  createRemoteBlockRuntimePort,
  loadProjectGraph,
  manifestSchema,
  projectCanvasWorkspace
} from "@planweave-ai/runtime";
import { opaqueIdentifierSchema } from "@planweave-ai/distributed-protocol";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { RemoteRuntimePortRegistry } from "./remoteRuntimeLocator.js";
import {
  createManifestWorkItemPort,
  createRoutedWorkItemPackagePort,
  type WorkItemPackagePort
} from "./work/index.js";

export const trustedRuntimeProjectSchema = z
  .object({
    projectId: opaqueIdentifierSchema,
    /**
     * Legacy compatibility hint. Runtime graph canvases are always trusted as
     * a whole; when supplied this value is validated but does not narrow the
     * expanded canvas set.
     */
    canvasId: opaqueIdentifierSchema.optional(),
    projectRoot: z.string().min(1).max(4096).refine(isAbsolute, "projectRoot must be absolute")
  })
  .strict();

export type TrustedRuntimeProject = z.infer<typeof trustedRuntimeProjectSchema>;

export type RuntimeCanvasExpansion = Readonly<{
  projectId: string;
  projectRoot: string;
  canvasId: string;
  packageDir: string;
}>;

export type TrustedRuntimeRegistry = {
  registry: RemoteRuntimePortRegistry;
  locators: Array<{ projectId: string; canvasId: string }>;
  readonly expansions: readonly RuntimeCanvasExpansion[];
  hasProject(projectId: string): boolean;
  hasCanvas(projectId: string, canvasId: string): boolean;
  workItemPackagePort(projectId: string): WorkItemPackagePort | undefined;
  close(): void;
};

export async function createTrustedRuntimeRegistry(
  rawProjects: readonly TrustedRuntimeProject[]
): Promise<TrustedRuntimeRegistry> {
  const projects = z.array(trustedRuntimeProjectSchema).min(1).parse(rawProjects);
  const registry = new RemoteRuntimePortRegistry();
  const unbind: Array<() => void> = [];
  const locators: Array<{ projectId: string; canvasId: string }> = [];
  const expansions: RuntimeCanvasExpansion[] = [];
  const canvasWorkItemPorts = new Map<string, Map<string, WorkItemPackagePort>>();
  const loadedGraphs = new Map<string, Awaited<ReturnType<typeof loadProjectGraph>>>();
  try {
    for (const project of projects) {
      let loaded = loadedGraphs.get(project.projectRoot);
      if (!loaded) {
        loaded = await loadProjectGraph(project.projectRoot);
        loadedGraphs.set(project.projectRoot, loaded);
      }
      if (loaded.workspace.id !== project.projectId)
        throw new Error("trusted_project_identity_mismatch");
      if (
        project.canvasId !== undefined &&
        !loaded.manifest.canvases.some((canvas) => canvas.id === project.canvasId)
      ) {
        throw new Error("trusted_project_canvas_not_declared");
      }
      let projectPorts = canvasWorkItemPorts.get(project.projectId);
      if (!projectPorts) {
        projectPorts = new Map();
        canvasWorkItemPorts.set(project.projectId, projectPorts);
      }
      for (const canvas of loaded.manifest.canvases) {
        const workspace = projectCanvasWorkspace(loaded.workspace, canvas);
        const locator = { projectId: project.projectId, canvasId: canvas.id };
        projectPorts.set(canvas.id, {
          resolveWorkItem(workItem) {
            const manifest = manifestSchema.parse(
              JSON.parse(readFileSync(workspace.manifestFile, "utf8"))
            );
            return createManifestWorkItemPort(manifest, canvas.id).resolveWorkItem(workItem);
          }
        });
        unbind.push(
          registry.bind(
            locator,
            createRemoteBlockRuntimePort({ projectRoot: workspace }),
            createRemoteBlockArtifactSource({ projectRoot: workspace })
          )
        );
        locators.push(locator);
        expansions.push(
          Object.freeze({
            projectId: project.projectId,
            projectRoot: project.projectRoot,
            canvasId: canvas.id,
            packageDir: workspace.packageDir
          })
        );
      }
    }
  } catch (error) {
    for (const release of unbind.reverse()) release();
    throw error;
  }
  const projectIds = new Set(locators.map((locator) => locator.projectId));
  const canvasIdsByProject = new Map(
    [...canvasWorkItemPorts].map(([projectId, ports]) => [projectId, new Set(ports.keys())])
  );
  const projectWorkItemPorts = new Map(
    [...canvasWorkItemPorts].map(([projectId, ports]) => [
      projectId,
      createRoutedWorkItemPackagePort((canvasId) => ports.get(canvasId))
    ])
  );
  return {
    registry,
    locators,
    expansions: Object.freeze(expansions),
    hasProject(projectId) {
      return projectIds.has(projectId);
    },
    hasCanvas(projectId, canvasId) {
      return canvasIdsByProject.get(projectId)?.has(canvasId) ?? false;
    },
    workItemPackagePort(projectId) {
      return projectWorkItemPorts.get(projectId);
    },
    close() {
      for (const release of unbind.splice(0).reverse()) release();
    }
  };
}
