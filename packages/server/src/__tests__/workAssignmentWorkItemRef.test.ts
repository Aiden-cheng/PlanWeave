import type { PlanPackageManifest } from "@planweave-ai/runtime";
import { compileTaskGraph } from "@planweave-ai/runtime";
import { describe, expect, it } from "vitest";
import {
  blockWorkItemRef,
  createCompiledGraphWorkItemPort,
  createManifestWorkItemPort,
  taskWorkItemRef,
  validateWorkItemRef,
  workItemFactsFromManifest
} from "../work/workItemFacts.js";

function assignmentManifest(): PlanPackageManifest {
  return {
    version: "plan-package/v1",
    project: {
      title: "Assignment WorkItemRef Fixture",
      description: "Temporary package shape for WorkItemRef validation."
    },
    execution: {
      parallel: { enabled: false, maxConcurrent: 1 }
    },
    review: {
      maxFeedbackCycles: 1,
      completionPolicy: "strict"
    },
    nodes: [
      {
        id: "T-001",
        type: "task",
        title: "Implement assignment contracts",
        prompt: "nodes/T-001/prompt.md",
        acceptance: ["Schemas exist."],
        blocks: [
          {
            id: "B-001",
            type: "implementation",
            title: "Define schemas",
            prompt: "nodes/T-001/blocks/B-001.prompt.md",
            depends_on: [],
            requirements: {
              capabilities: ["acp.codex", "node"]
            }
          },
          {
            id: "R-001",
            type: "review",
            title: "Review schemas",
            prompt: "nodes/T-001/blocks/R-001.prompt.md",
            depends_on: ["B-001"],
            review: {
              required: true,
              maxFeedbackCycles: 1,
              hook: null
            }
          }
        ]
      },
      {
        id: "T-002",
        type: "task",
        title: "Second task",
        prompt: "nodes/T-002/prompt.md",
        acceptance: ["Second task complete."],
        blocks: [
          {
            id: "B-001",
            type: "implementation",
            title: "Second block without requirements",
            prompt: "nodes/T-002/blocks/B-001.prompt.md",
            depends_on: []
          }
        ]
      }
    ],
    edges: []
  };
}

describe("WorkItemRef validation against real package graphs", () => {
  it("resolves tasks and blocks from a compiled Plan Package manifest", () => {
    const manifest = assignmentManifest();
    const port = createManifestWorkItemPort(manifest, "default");

    const task = validateWorkItemRef(port, taskWorkItemRef("default", "T-001"));
    expect(task.ok).toBe(true);
    if (!task.ok) throw new Error("expected task");
    expect(task.facts).toMatchObject({
      kind: "task",
      exists: true,
      taskId: "T-001",
      requiredCapabilities: []
    });

    const block = validateWorkItemRef(port, blockWorkItemRef("default", "T-001#B-001"));
    expect(block.ok).toBe(true);
    if (!block.ok) throw new Error("expected block");
    expect(block.facts).toMatchObject({
      kind: "block",
      exists: true,
      blockRef: "T-001#B-001",
      blockType: "implementation",
      requiredCapabilities: ["acp.codex", "node"]
    });

    const review = workItemFactsFromManifest(
      manifest,
      "default",
      blockWorkItemRef("default", "T-001#R-001")
    );
    expect(review.exists).toBe(true);
    expect(review.blockType).toBe("review");
    expect(review.requiredCapabilities).toEqual([]);

    const bare = workItemFactsFromManifest(
      manifest,
      "default",
      blockWorkItemRef("default", "T-002#B-001")
    );
    expect(bare.exists).toBe(true);
    expect(bare.requiredCapabilities).toEqual([]);
  });

  it("rejects missing, cross-canvas, and unknown work items without mutating the package", () => {
    const graph = compileTaskGraph(assignmentManifest());
    const port = createCompiledGraphWorkItemPort(graph, "default");

    expect(validateWorkItemRef(port, taskWorkItemRef("default", "T-999"))).toMatchObject({
      ok: false,
      code: "work_item_not_found"
    });
    expect(
      validateWorkItemRef(port, blockWorkItemRef("default", "T-001#B-999"))
    ).toMatchObject({ ok: false, code: "work_item_not_found" });
    expect(
      validateWorkItemRef(port, taskWorkItemRef("other-canvas", "T-001"))
    ).toMatchObject({ ok: false, code: "work_item_not_found" });
  });

  it("keeps automatic Host selection requirements on the Block, not on assignment targets", () => {
    const facts = workItemFactsFromManifest(
      assignmentManifest(),
      "default",
      blockWorkItemRef("default", "T-001#B-001")
    );
    // Truth source for automatic selection is packageFacts.requiredCapabilities.
    expect(facts.requiredCapabilities).toEqual(["acp.codex", "node"]);
    expect(facts).not.toHaveProperty("assignee");
  });
});
