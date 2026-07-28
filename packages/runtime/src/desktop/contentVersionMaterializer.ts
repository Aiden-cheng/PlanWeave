import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type CompleteContentVersion } from "@planweave-ai/collaboration-contracts";
import { resolveTaskCanvasWorkspace } from "./canvasApi.js";
import { layoutPathForWorkspace, parseDesktopLayoutForPackage } from "./layoutStore.js";
import { validateAuthoritativeCanvasContent } from "./contentVersionValidation.js";
import { ImportTransaction } from "../package/importTransaction.js";
import { loadPackage } from "../package/loadPackage.js";
import { resolvePackagePath } from "../package/resolvePackagePath.js";

function fail(code: string): Error {
  return new Error(code);
}

/**
 * Main-process-only content replacement boundary. The logical layout member is
 * resolved through the runtime layout store; callers never provide disk paths.
 */
export async function materializeAuthoritativeCanvasContent(input: {
  projectRoot: string;
  canvasId: string;
  expectedPackageDir?: string;
  content: CompleteContentVersion;
}): Promise<void> {
  const validated = validateAuthoritativeCanvasContent(input.content);
  const content = validated.content;
  const workspace = await resolveTaskCanvasWorkspace(input.projectRoot, input.canvasId);
  if (input.expectedPackageDir && workspace.packageDir !== input.expectedPackageDir) {
    throw fail("runtime_package_location_mismatch");
  }
  const packageMembers = content.members.filter((member) => member.kind !== "desktop_layout");
  const staging = await mkdtemp(join(dirname(workspace.packageDir), ".planweave-content-version-"));
  const transaction = await ImportTransaction.create({ workspaceRoot: workspace.workspaceRoot });
  try {
    for (const member of packageMembers) {
      const target = await resolvePackagePath(staging, member.path, { forWrite: true });
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, member.content, "utf8");
    }
    const stagedWorkspace = { ...workspace, packageDir: staging, manifestFile: join(staging, "manifest.json") };
    const { manifest } = await loadPackage(stagedWorkspace);
    const parsedLayout = parseDesktopLayoutForPackage(validated.layout, stagedWorkspace, manifest);
    const stagedLayout = join(dirname(staging), `${staging.split("/").at(-1)!}.layout.json`);
    await writeFile(stagedLayout, `${JSON.stringify(parsedLayout, null, 2)}\n`, "utf8");
    await transaction.replacePath(workspace.packageDir, staging);
    await transaction.replacePath(layoutPathForWorkspace(workspace), stagedLayout);
    await transaction.commit();
  } catch (error) {
    try {
      await transaction.rollback();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "content_version_materialization_failed");
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    throw error;
  }
}
