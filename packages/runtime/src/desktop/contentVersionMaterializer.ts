import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  canonicalContentVersionDigestPayload,
  completeContentVersionSchema,
  contentVersionDesktopLayoutMemberPath,
  type CompleteContentVersion
} from "@planweave-ai/collaboration-contracts";
import { resolveTaskCanvasWorkspace } from "./canvasApi.js";
import { layoutPathForWorkspace, parseDesktopLayoutForPackage } from "./layoutStore.js";
import { ImportTransaction } from "../package/importTransaction.js";
import { loadPackage } from "../package/loadPackage.js";
import { resolvePackagePath } from "../package/resolvePackagePath.js";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

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
  const content = completeContentVersionSchema.parse(input.content);
  for (const member of content.members) {
    if (member.sizeBytes !== Buffer.byteLength(member.content, "utf8") || member.digestSha256 !== sha256(member.content)) {
      throw fail("content_version_member_digest_mismatch");
    }
  }
  if (content.canonicalDigest !== sha256(canonicalContentVersionDigestPayload(content))) {
    throw fail("content_version_canonical_digest_mismatch");
  }
  const workspace = await resolveTaskCanvasWorkspace(input.projectRoot, input.canvasId);
  if (input.expectedPackageDir && workspace.packageDir !== input.expectedPackageDir) {
    throw fail("runtime_package_location_mismatch");
  }
  const layout = content.members.find((member) => member.path === contentVersionDesktopLayoutMemberPath);
  if (!layout) throw fail("content_version_layout_missing");
  const packageMembers = content.members.filter((member) => member.path !== contentVersionDesktopLayoutMemberPath);
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
    const parsedLayout = parseDesktopLayoutForPackage(JSON.parse(layout.content) as unknown, stagedWorkspace, manifest);
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
