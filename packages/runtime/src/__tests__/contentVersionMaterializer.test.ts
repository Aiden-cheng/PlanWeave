import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalContentVersionDigestPayload,
  completeContentVersionSchema,
  contentVersionDesktopLayoutMemberPath,
  type CompleteContentVersion
} from "@planweave-ai/collaboration-contracts";
import {
  capturePackageSnapshot,
  getDesktopLayout,
  materializeAuthoritativeCanvasContent,
  resolveTaskCanvasWorkspace,
  saveDesktopLayout
} from "../index.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

const directories: string[] = [];
const originalHome = process.env.PLANWEAVE_HOME;
const originalSettingsFile = process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;

afterEach(async () => {
  if (originalHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalHome;
  if (originalSettingsFile === undefined) delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  else process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = originalSettingsFile;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function contentFromWorkspace(projectRoot: string): Promise<CompleteContentVersion> {
  const workspace = await resolveTaskCanvasWorkspace(projectRoot, "default");
  const snapshot = await capturePackageSnapshot({ projectRoot, canvasId: "default" });
  const layout = await getDesktopLayout(workspace);
  const members = [
    ...snapshot.snapshot.files.map((file) => ({
      kind: file.path === "manifest.json" ? "manifest" as const : file.path.includes("/blocks/") ? "block_prompt" as const : "task_prompt" as const,
      path: file.path,
      content: file.content,
      digestSha256: file.digestSha256,
      sizeBytes: file.sizeBytes
    })),
    {
      kind: "desktop_layout" as const,
      path: contentVersionDesktopLayoutMemberPath,
      content: `${JSON.stringify(layout, null, 2)}\n`,
      digestSha256: "",
      sizeBytes: 0
    }
  ].map((member) => member.kind === "desktop_layout"
    ? { ...member, digestSha256: sha256(member.content), sizeBytes: Buffer.byteLength(member.content, "utf8") }
    : member
  ).sort((left, right) => left.path.localeCompare(right.path));
  const totalBytes = members.reduce((total, member) => total + member.sizeBytes, 0);
  const provisional = { members, totalBytes, canonicalDigest: "0".repeat(64) };
  return completeContentVersionSchema.parse({
    ...provisional,
    canonicalDigest: sha256(canonicalContentVersionDigestPayload(provisional))
  });
}

describe("authoritative content materializer", () => {
  it("replaces package and logical layout together after validating the authoritative digest", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    await saveDesktopLayout(workspace.root, {
      version: "desktop-layout/v1",
      projectId: workspace.init.workspace.id,
      nodes: [{ nodeId: "T-001", x: 120, y: 240 }],
      updatedAt: "2026-07-28T00:00:00.000Z"
    });
    const authoritative = await contentFromWorkspace(workspace.root);
    const canvas = await resolveTaskCanvasWorkspace(workspace.root, "default");
    const promptPath = join(canvas.packageDir, "nodes", "T-001", "prompt.md");
    await writeFile(promptPath, "# local divergent prompt\n", "utf8");
    await saveDesktopLayout(workspace.root, {
      version: "desktop-layout/v1",
      projectId: workspace.init.workspace.id,
      nodes: [{ nodeId: "T-001", x: 1, y: 2 }],
      updatedAt: "2026-07-28T00:01:00.000Z"
    });

    await materializeAuthoritativeCanvasContent({
      projectRoot: workspace.root,
      canvasId: "default",
      expectedPackageDir: canvas.packageDir,
      content: authoritative
    });

    await expect(readFile(promptPath, "utf8")).resolves.toBe("# T-001 task prompt\n");
    await expect(getDesktopLayout(workspace.root)).resolves.toMatchObject({
      nodes: [{ nodeId: "T-001", x: 120, y: 240 }]
    });
  });

  it("fails closed on a member digest mismatch without replacing either local artifact", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const canvas = await resolveTaskCanvasWorkspace(workspace.root, "default");
    const promptPath = join(canvas.packageDir, "nodes", "T-001", "prompt.md");
    await writeFile(promptPath, "# preserve this prompt\n", "utf8");
    await saveDesktopLayout(workspace.root, {
      version: "desktop-layout/v1",
      projectId: workspace.init.workspace.id,
      nodes: [{ nodeId: "T-001", x: 9, y: 8 }],
      updatedAt: "2026-07-28T00:02:00.000Z"
    });
    const content = await contentFromWorkspace(workspace.root);
    const members = content.members.map((member) => member.path === "manifest.json"
      ? { ...member, digestSha256: "0".repeat(64) }
      : member
    );
    const malformed = completeContentVersionSchema.parse({
      members,
      totalBytes: content.totalBytes,
      canonicalDigest: sha256(canonicalContentVersionDigestPayload({
        members,
        totalBytes: content.totalBytes,
        canonicalDigest: "0".repeat(64)
      }))
    });

    await expect(materializeAuthoritativeCanvasContent({
      projectRoot: workspace.root,
      canvasId: "default",
      content: malformed
    })).rejects.toThrow("content_version_member_digest_mismatch");

    await expect(readFile(promptPath, "utf8")).resolves.toBe("# preserve this prompt\n");
    await expect(getDesktopLayout(workspace.root)).resolves.toMatchObject({
      nodes: [{ nodeId: "T-001", x: 9, y: 8 }]
    });
  });
});
