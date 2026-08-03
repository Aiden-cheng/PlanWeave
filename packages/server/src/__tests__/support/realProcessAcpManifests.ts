import type { PlanPackageManifest } from "@planweave-ai/runtime";
import { basicManifest } from "../../../../runtime/src/__tests__/promptTestHelpers.js";

export function remoteAcpManifest(): PlanPackageManifest {
  const manifest = basicManifest();
  manifest.execution.defaultExecutor = "codex-acp";
  manifest.executors = {
    "codex-acp": { adapter: "agent", agent: "codex", runner: { transport: "acp" } }
  };
  manifest.nodes[0].blocks[0].requirements = { capabilities: ["acp.codex"] };
  return manifest;
}

/** Manifest with T-001#B-002 depending on T-001#B-001 for dependency/artifact scenarios. */
export function remoteAcpManifestWithDependency(): PlanPackageManifest {
  const manifest = remoteAcpManifest();
  const task = manifest.nodes[0];
  if (task.type !== "task") throw new Error("remote_acp_manifest_expected_task");
  task.blocks.splice(1, 0, {
    id: "B-002",
    type: "implementation",
    title: "Consume first implementation",
    prompt: "nodes/T-001/blocks/B-002.prompt.md",
    depends_on: ["B-001"],
    requirements: { capabilities: ["acp.codex"] }
  });
  const review = task.blocks.find((block) => block.id === "R-001");
  if (review) review.depends_on = ["B-002"];
  return manifest;
}

/** Parallel two-task manifest for capacity contention matrices. */
export function remoteAcpManifestParallelCapacity(): PlanPackageManifest {
  const manifest = basicManifest({ parallel: true, maxConcurrent: 2, includeSecondTask: true });
  manifest.execution.defaultExecutor = "codex-acp";
  manifest.executors = {
    "codex-acp": { adapter: "agent", agent: "codex", runner: { transport: "acp" } }
  };
  for (const node of manifest.nodes) {
    if (node.type !== "task") continue;
    for (const block of node.blocks) {
      if (block.type === "implementation") {
        block.requirements = { capabilities: ["acp.codex"] };
      }
    }
  }
  return manifest;
}
