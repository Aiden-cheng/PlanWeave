import { isAbsolute, relative } from "node:path";
import { z } from "zod";
import { ownerPackageLocatorSchema, type OwnerPackageLocator } from "./ownerPackageLocator.js";

export { ownerPackageLocatorSchema, type OwnerPackageLocator } from "./ownerPackageLocator.js";

export const resolvedHostWorkspaceSchema = z
  .object({
    absolutePath: z.string().min(1).max(4096)
  })
  .strict();

export type ResolvedHostWorkspace = z.infer<typeof resolvedHostWorkspaceSchema>;

export type OwnerRunWorkspaceResolverErrorCode =
  | "owner_fleet_workspace_root_missing"
  | "owner_fleet_package_path_invalid"
  | "owner_fleet_workspace_escape";

export class OwnerRunWorkspaceResolverError extends Error {
  constructor(readonly code: OwnerRunWorkspaceResolverErrorCode) {
    super(code);
    this.name = "OwnerRunWorkspaceResolverError";
  }
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/** Resolve an Owner Fleet run to an absolute, contained Host workspace directory. */
export function resolveOwnerRunWorkspace(input: {
  workspaceRoot: string;
  locator: OwnerPackageLocator;
}): ResolvedHostWorkspace {
  const locator = ownerPackageLocatorSchema.parse(input.locator);
  const root = input.workspaceRoot.trim();
  if (!root || !isAbsolute(root)) {
    throw new OwnerRunWorkspaceResolverError("owner_fleet_workspace_root_missing");
  }
  const absolutePath = `${root.replace(/\/+$/, "")}/${locator.relativePackagePath}`;
  if (!contained(root, absolutePath)) {
    throw new OwnerRunWorkspaceResolverError("owner_fleet_workspace_escape");
  }
  return resolvedHostWorkspaceSchema.parse({ absolutePath });
}

/** Build a stable fleet package path from server run coordinates. */
export function ownerPackageLocatorForRun(input: {
  projectId: string;
  canvasId: string;
}): OwnerPackageLocator {
  const projectId = input.projectId.trim();
  const canvasId = input.canvasId.trim();
  if (!projectId || !canvasId) {
    throw new OwnerRunWorkspaceResolverError("owner_fleet_package_path_invalid");
  }
  return ownerPackageLocatorSchema.parse({
    strategy: "host_relative_package",
    relativePackagePath: `fleet-runs/${projectId}/${canvasId}`
  });
}
