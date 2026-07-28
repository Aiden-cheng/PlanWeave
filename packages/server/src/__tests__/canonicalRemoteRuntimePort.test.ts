import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createRemoteBlockRuntimePort } from "@planweave-ai/runtime";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { canonicalRemoteRuntimePort } from "../canonicalRemoteRuntimePort.js";

const directories: string[] = [];

function remoteManifest() {
  const manifest = basicManifest();
  manifest.execution.defaultExecutor = "codex-acp";
  manifest.executors = {
    "codex-acp": {
      adapter: "agent",
      agent: "codex",
      runner: { transport: "acp" }
    }
  };
  return manifest;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("canonicalRemoteRuntimePort", () => {
  it("replaces only the local workspace identity in inspected dispatch candidates", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    const runtime = createRemoteBlockRuntimePort({ projectRoot: workspace.root });
    const canonicalWorkspaceId = "server-workspace";
    const adapted = canonicalRemoteRuntimePort(runtime, canonicalWorkspaceId);

    const localCandidate = await runtime.inspect({ ref: "T-001#B-001" });
    const canonicalCandidate = await adapted.inspect({ ref: "T-001#B-001" });

    expect(localCandidate.workspaceId).toBe(workspace.init.workspace.id);
    expect(canonicalCandidate).toEqual({
      ...localCandidate,
      workspaceId: canonicalWorkspaceId
    });
  });

  it("forwards mutation operations to the underlying Runtime port", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    const runtime = createRemoteBlockRuntimePort({ projectRoot: workspace.root });
    const adapted = canonicalRemoteRuntimePort(runtime, "server-workspace");
    const candidate = await adapted.inspect({ ref: "T-001#B-001" });

    const binding = await adapted.claim({
      ref: candidate.blockRef,
      operationId: "operation-1",
      sourceRevision: candidate.sourceRevision,
      graphFingerprint: candidate.graphFingerprint
    });

    expect(binding.ownership).toMatchObject({ operationId: "operation-1", phase: "preparing" });
    await expect(
      adapted.query({ ref: candidate.blockRef, operationId: "operation-1" })
    ).resolves.toEqual(binding);
  });
});
