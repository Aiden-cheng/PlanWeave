import {
  createRemoteBlockArtifactSource,
  createRemoteBlockRuntimePort,
  resolveProjectCanvasWorkspace
} from "@planweave-ai/runtime";
import { opaqueIdentifierSchema } from "@planweave-ai/distributed-protocol";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { RemoteRuntimePortRegistry } from "./remoteRuntimeLocator.js";

export const trustedRuntimeProjectSchema = z
  .object({
    projectId: opaqueIdentifierSchema,
    canvasId: opaqueIdentifierSchema,
    projectRoot: z.string().min(1).max(4096).refine(isAbsolute, "projectRoot must be absolute")
  })
  .strict();

export type TrustedRuntimeProject = z.infer<typeof trustedRuntimeProjectSchema>;

export type TrustedRuntimeRegistry = {
  registry: RemoteRuntimePortRegistry;
  locators: Array<{ projectId: string; canvasId: string }>;
  hasProject(projectId: string): boolean;
  close(): void;
};

export async function createTrustedRuntimeRegistry(
  rawProjects: readonly TrustedRuntimeProject[]
): Promise<TrustedRuntimeRegistry> {
  const projects = z.array(trustedRuntimeProjectSchema).min(1).parse(rawProjects);
  const registry = new RemoteRuntimePortRegistry();
  const unbind: Array<() => void> = [];
  const locators: Array<{ projectId: string; canvasId: string }> = [];
  try {
    for (const project of projects) {
      const workspace = await resolveProjectCanvasWorkspace(project.projectRoot, project.canvasId);
      if (workspace.id !== project.projectId) throw new Error("trusted_project_identity_mismatch");
      const locator = { projectId: project.projectId, canvasId: project.canvasId };
      unbind.push(
        registry.bind(
          locator,
          createRemoteBlockRuntimePort({ projectRoot: workspace }),
          createRemoteBlockArtifactSource({ projectRoot: workspace })
        )
      );
      locators.push(locator);
    }
  } catch (error) {
    for (const release of unbind.reverse()) release();
    throw error;
  }
  const projectIds = new Set(locators.map((locator) => locator.projectId));
  return {
    registry,
    locators,
    hasProject(projectId) {
      return projectIds.has(projectId);
    },
    close() {
      for (const release of unbind.splice(0).reverse()) release();
    }
  };
}
