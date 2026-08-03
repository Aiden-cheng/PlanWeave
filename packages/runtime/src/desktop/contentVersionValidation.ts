import { createHash } from "node:crypto";
import {
  canonicalContentVersionDigestPayload,
  completeContentVersionSchema,
  contentVersionDesktopLayoutMemberPath,
  type CompleteContentVersion,
  type ContentVersionMember,
  type ContentVersionMemberKind
} from "@planweave-ai/collaboration-protocol";
import { manifestSchema } from "../schema/manifest.js";
import type { PlanPackageManifest } from "../types.js";
import { desktopLayoutFileSchema, type DesktopLayout } from "./types/desktopLayoutSchema.js";

export type ValidatedAuthoritativeCanvasContent = {
  content: CompleteContentVersion;
  manifest: PlanPackageManifest;
  layout: DesktopLayout;
};

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function expectedPromptMembers(manifest: PlanPackageManifest): Map<string, ContentVersionMemberKind> {
  const expected = new Map<string, ContentVersionMemberKind>();
  const add = (path: string, kind: ContentVersionMemberKind) => {
    const existing = expected.get(path);
    if (existing && existing !== kind) throw new Error("content_version_prompt_kind_conflict");
    expected.set(path, kind);
  };
  for (const task of manifest.nodes) {
    add(task.prompt, "task_prompt");
    for (const block of task.blocks) add(block.prompt, "block_prompt");
  }
  return expected;
}

function verifyMemberDigests(content: CompleteContentVersion): void {
  for (const member of content.members) {
    if (member.sizeBytes !== Buffer.byteLength(member.content, "utf8")) {
      throw new Error("content_version_member_size_mismatch");
    }
    if (member.digestSha256 !== sha256(member.content)) {
      throw new Error("content_version_member_digest_mismatch");
    }
  }
  if (content.canonicalDigest !== sha256(canonicalContentVersionDigestPayload(content))) {
    throw new Error("content_version_canonical_digest_mismatch");
  }
}

function memberAtPath(content: CompleteContentVersion, path: string): ContentVersionMember {
  const member = content.members.find((candidate) => candidate.path === path);
  if (!member) throw new Error(`content_version_member_missing:${path}`);
  return member;
}

/**
 * Verifies the complete logical Plan Package represented by an immutable content version.
 * This pure boundary is shared by server persistence and runtime materialization.
 */
export function validateAuthoritativeCanvasContent(
  rawContent: unknown
): ValidatedAuthoritativeCanvasContent {
  const content = completeContentVersionSchema.parse(rawContent);
  verifyMemberDigests(content);

  const manifestMember = memberAtPath(content, "manifest.json");
  const manifest = manifestSchema.parse(JSON.parse(manifestMember.content)) as PlanPackageManifest;
  const layoutMember = memberAtPath(content, contentVersionDesktopLayoutMemberPath);
  const layout = desktopLayoutFileSchema.parse(JSON.parse(layoutMember.content));

  const expected = expectedPromptMembers(manifest);
  const actual = new Map(
    content.members
      .filter((member) => member.kind === "task_prompt" || member.kind === "block_prompt")
      .map((member) => [member.path, member.kind] as const)
  );
  if (actual.size !== expected.size) throw new Error("content_version_prompt_set_mismatch");
  for (const [path, kind] of expected) {
    if (actual.get(path) !== kind) throw new Error("content_version_prompt_set_mismatch");
  }

  return { content, manifest, layout };
}
