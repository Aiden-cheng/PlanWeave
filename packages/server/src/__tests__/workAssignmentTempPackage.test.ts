import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileTaskGraph,
  initWorkspace,
  loadPackage,
  type PlanPackageManifest
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  blockWorkItemRef,
  createCompiledGraphWorkItemPort,
  taskWorkItemRef,
  validateWorkItemRef
} from "../work/workItemFacts.js";

const cleanups: string[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const path = cleanups.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

async function writeTempPackage(): Promise<{
  home: string;
  root: string;
  packageDir: string;
  manifest: PlanPackageManifest;
}> {
  const home = await mkdtemp(join(tmpdir(), "planweave-assign-home-"));
  const root = await mkdtemp(join(tmpdir(), "planweave-assign-project-"));
  cleanups.push(home, root);
  process.env.PLANWEAVE_HOME = home;

  const init = await initWorkspace({ projectRoot: root });
  const manifest: PlanPackageManifest = {
    version: "plan-package/v1",
    project: {
      title: "Temp Assignment Package",
      description: "On-disk temporary package for WorkItemRef validation."
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
        id: "HC-002",
        type: "task",
        title: "Assignment task",
        prompt: "nodes/HC-002/prompt.md",
        acceptance: ["WorkItemRef resolves from disk package."],
        blocks: [
          {
            id: "B-001",
            type: "implementation",
            title: "Contracts",
            prompt: "nodes/HC-002/blocks/B-001.prompt.md",
            depends_on: [],
            requirements: {
              capabilities: ["workspace.git", "acp.codex"]
            }
          }
        ]
      }
    ],
    edges: []
  };

  await writeFile(init.workspace.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await mkdir(join(init.workspace.packageDir, "nodes", "HC-002", "blocks"), { recursive: true });
  await writeFile(
    join(init.workspace.packageDir, "nodes", "HC-002", "prompt.md"),
    "# task\n",
    "utf8"
  );
  await writeFile(
    join(init.workspace.packageDir, "nodes", "HC-002", "blocks", "B-001.prompt.md"),
    "# block\n",
    "utf8"
  );

  return {
    home,
    root,
    packageDir: init.workspace.packageDir,
    manifest
  };
}

describe("WorkItemRef against real temporary packages", () => {
  it("loads a temporary on-disk Plan Package and validates WorkItemRef facts", async () => {
    const { root, manifest } = await writeTempPackage();
    const loaded = await loadPackage(root);
    expect(loaded.manifest.project.title).toBe(manifest.project.title);

    const graph = compileTaskGraph(loaded.manifest);
    const port = createCompiledGraphWorkItemPort(graph, "default");

    const task = validateWorkItemRef(port, taskWorkItemRef("default", "HC-002"));
    expect(task.ok).toBe(true);
    if (!task.ok) throw new Error("expected task");

    const block = validateWorkItemRef(port, blockWorkItemRef("default", "HC-002#B-001"));
    expect(block.ok).toBe(true);
    if (!block.ok) throw new Error("expected block");
    expect(block.facts.requiredCapabilities).toEqual(["workspace.git", "acp.codex"]);

    // Missing refs stay not-found; package files are not written by validation.
    expect(
      validateWorkItemRef(port, blockWorkItemRef("default", "HC-002#B-999"))
    ).toMatchObject({ ok: false, code: "work_item_not_found" });
  });
});
