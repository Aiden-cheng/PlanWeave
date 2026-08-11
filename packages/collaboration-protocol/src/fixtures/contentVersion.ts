import {
  authoritativeContentVersionSchema,
  canonicalContentVersionDigestPayload,
  completeContentVersionSchema,
  type CompleteContentVersion
} from "../contentVersion.js";

const digest = (character: string) => character.repeat(64);

export const exampleCompleteContentVersion: CompleteContentVersion =
  completeContentVersionSchema.parse({
    members: [
      {
        kind: "desktop_layout",
        path: "desktop/layout.json",
        content: "{}",
        digestSha256: digest("a"),
        sizeBytes: 2
      },
      {
        kind: "manifest",
        path: "manifest.json",
        content: "{}",
        digestSha256: digest("b"),
        sizeBytes: 2
      },
      {
        kind: "block_prompt",
        path: "nodes/OSS-007/blocks/B-001.prompt.md",
        content: "# Block\n",
        digestSha256: digest("c"),
        sizeBytes: 8
      },
      {
        kind: "task_prompt",
        path: "nodes/OSS-007/prompt.md",
        content: "# Task\n",
        digestSha256: digest("d"),
        sizeBytes: 7
      }
    ],
    canonicalDigest: digest("e"),
    totalBytes: 19
  });

export const exampleContentVersionCanonicalPayload = canonicalContentVersionDigestPayload(
  exampleCompleteContentVersion
);

export const exampleAuthoritativeContentVersion = authoritativeContentVersionSchema.parse({
  schemaVersion: "content-version/v1",
  scope: {
    workspaceId: "workspace-demo-001",
    projectId: "project-demo-001",
    canvasId: "canvas-default"
  },
  content: exampleCompleteContentVersion,
  completed: {
    versionId: `version-${exampleCompleteContentVersion.canonicalDigest}`,
    canonicalDigest: exampleCompleteContentVersion.canonicalDigest,
    verification: "complete"
  },
  createdAt: "2030-01-01T00:00:00.000Z",
  createdBy: { kind: "human", id: "human-owner-001", displayName: "Owner" }
});
