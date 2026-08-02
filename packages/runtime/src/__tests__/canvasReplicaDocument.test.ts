import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CanvasCommandIntent } from "@planweave-ai/collaboration-contracts";
import {
  applyAuthorizedCanvasCommand,
  applyCanvasReplicaIntent,
  captureAuthorizedCanvasContent,
  decodeCanvasReplicaDocument,
  encodeCanvasReplicaDocument,
  parseCanvasReplicaDocument,
  type CanvasReplicaDocument
} from "../index.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";
import { getDesktopLayoutDirect } from "../desktop/layoutStore.js";
import { buildCanvasCommandApplication } from "../graph/canvasCommandMutation.js";
import { commitCanvasCommandApplication } from "../graph/canvasCommandPort.js";
import { loadPackage } from "../package/loadPackage.js";
import {
  listPendingImportTransactions,
  rollbackPendingImportTransaction
} from "../package/importRecovery.js";

const directories: string[] = [];
const originalHome = process.env.PLANWEAVE_HOME;
const originalSettings = process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;

afterEach(async () => {
  if (originalHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalHome;
  if (originalSettings === undefined) delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  else process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = originalSettings;
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function baseDocument(): CanvasReplicaDocument {
  const manifest = basicManifest({ includeSecondTask: true });
  const promptMarkdownByPath = Object.fromEntries(
    manifest.nodes.flatMap((task) => [
      [task.prompt, `# ${task.id} task\n`],
      ...task.blocks.map((block) => [block.prompt, `# ${task.id} ${block.id}\n`])
    ])
  );
  return parseCanvasReplicaDocument({
    schemaVersion: "canvas-replica-document/v1",
    manifest,
    promptMarkdownByPath,
    layout: {
      version: "desktop-layout/v1",
      projectId: "project-authority",
      nodes: [
        { nodeId: "T-001", x: 10, y: 20 },
        { nodeId: "T-002", x: 30, y: 40 }
      ],
      updatedAt: "2026-08-02T00:00:00.000Z"
    }
  });
}

function task(document: CanvasReplicaDocument, taskId: string) {
  const found = document.manifest.nodes.find((candidate) => candidate.id === taskId);
  if (!found) throw new Error(`test_task_missing:${taskId}`);
  return found;
}

function apply(document: CanvasReplicaDocument, intent: CanvasCommandIntent) {
  return applyCanvasReplicaIntent(document, intent);
}

async function expectDiskMatchesReplica(intent: CanvasCommandIntent): Promise<void> {
  const workspace = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
  directories.push(workspace.home, workspace.root);
  const authorityProjectId = "project-authority";
  const before = await captureAuthorizedCanvasContent({
    projectRoot: workspace.init.workspace,
    authorityProjectId
  });
  const expected = encodeCanvasReplicaDocument(
    apply(decodeCanvasReplicaDocument(before.content), intent)
  );
  const applied = await applyAuthorizedCanvasCommand({
    projectRoot: workspace.init.workspace,
    canvasId: "default",
    authorityProjectId,
    intent
  });
  expect(applied.ok).toBe(true);
  const captured = await captureAuthorizedCanvasContent({
    projectRoot: workspace.init.workspace,
    authorityProjectId
  });
  expect(captured.content).toEqual(expected);
}

describe("CanvasReplicaDocument", () => {
  it("round-trips complete semantic content and rejects tampering or incomplete surfaces", () => {
    const document = baseDocument();
    const content = encodeCanvasReplicaDocument(document);
    const decoded = decodeCanvasReplicaDocument(content);

    expect(decoded).toEqual(document);
    expect(encodeCanvasReplicaDocument(decoded)).toEqual(content);
    expect(() => {
      content.members[0]!.content = "tampered";
    }).toThrow();

    const manifestMember = content.members.find((member) => member.kind === "manifest")!;
    expect(() =>
      decodeCanvasReplicaDocument({
        ...content,
        members: content.members.map((member) =>
          member === manifestMember ? { ...member, content: "{}\n" } : member
        )
      })
    ).toThrow();
    expect(() =>
      parseCanvasReplicaDocument({
        ...document,
        promptMarkdownByPath: {
          ...document.promptMarkdownByPath,
          "nodes/T-999/prompt.md": "unexpected"
        }
      })
    ).toThrow("canvas_replica_prompt_set_mismatch");
    expect(() =>
      parseCanvasReplicaDocument({
        ...document,
        layout: {
          ...document.layout,
          nodes: [...document.layout.nodes, { nodeId: "T-999", x: 0, y: 0 }]
        }
      })
    ).toThrow("canvas_replica_layout_node_unknown");
  });

  it("isolates and freezes ingress while returning a distinct immutable result", () => {
    const source = JSON.parse(JSON.stringify(baseDocument()));
    const document = parseCanvasReplicaDocument(source);
    source.manifest.nodes[0].title = "external mutation";
    expect(task(document, "T-001").title).toBe("Implement test task");
    expect(() => {
      document.manifest.nodes[0]!.title = "forbidden";
    }).toThrow();

    const result = apply(document, {
      kind: "update_task_fields",
      taskId: "T-001",
      fields: { title: "Renamed" }
    });
    expect(result).not.toBe(document);
    expect(task(result, "T-001").title).toBe("Renamed");
    expect(task(document, "T-001").title).toBe("Implement test task");
  });

  it("applies task, block, prompt, bulk, and layout intents with complete semantics", () => {
    let document = baseDocument();
    document = apply(document, {
      kind: "update_task_fields",
      taskId: "T-001",
      fields: {
        title: "Task renamed",
        promptMarkdown: "task body",
        executor: "codex",
        acceptance: ["Accepted"]
      }
    });
    expect(task(document, "T-001")).toMatchObject({
      title: "Task renamed",
      executor: "codex",
      acceptance: ["Accepted"]
    });
    expect(task(document, "T-001").blocks.every((block) => block.executor === undefined)).toBe(true);
    expect(document.promptMarkdownByPath[task(document, "T-001").prompt]).toBe("task body");

    document = apply(document, {
      kind: "update_task_prompt",
      taskId: "T-001",
      promptMarkdown: "new task body"
    });
    document = apply(document, {
      kind: "update_block_fields",
      blockRef: "T-001#B-001",
      fields: {
        title: "Implementation renamed",
        promptMarkdown: "implementation body",
        dependsOn: [],
        sharedResources: ["database"],
        requiredCapabilities: ["network"]
      }
    });
    const implementation = task(document, "T-001").blocks[0]!;
    expect(implementation).toMatchObject({
      title: "Implementation renamed",
      parallel: { sharedResources: ["database"] },
      requirements: { capabilities: ["network"] }
    });
    expect(document.promptMarkdownByPath[implementation.prompt]).toBe("implementation body");

    document = apply(document, {
      kind: "update_block_prompt",
      blockRef: "T-001#B-001",
      promptMarkdown: "prompt only"
    });
    document = apply(document, {
      kind: "bulk_update_blocks",
      updates: [
        {
          blockRef: "T-001#B-001",
          fields: { title: "Bulk implementation", promptMarkdown: "bulk body" }
        },
        {
          blockRef: "T-001#R-001",
          fields: { reviewRequired: false, maxFeedbackCycles: 3 }
        }
      ]
    });
    const [bulkImplementation, review] = task(document, "T-001").blocks;
    expect(bulkImplementation!.title).toBe("Bulk implementation");
    expect(document.promptMarkdownByPath[bulkImplementation!.prompt]).toBe("bulk body");
    expect(review).toMatchObject({
      type: "review",
      review: { required: false, maxFeedbackCycles: 3 }
    });

    document = apply(document, {
      kind: "update_layout",
      nodes: [{ nodeId: "T-001", x: 100, y: 200 }],
      updatedAt: "2026-08-02T01:00:00.000Z"
    });
    expect(document.layout).toMatchObject({
      updatedAt: "2026-08-02T01:00:00.000Z",
      nodes: [
        { nodeId: "T-001", x: 100, y: 200 },
        { nodeId: "T-002", x: 30, y: 40 }
      ]
    });
  });

  it("applies structural intents, including idempotent removal and reconnect semantics", () => {
    let document = baseDocument();
    document = apply(document, {
      kind: "add_block",
      taskId: "T-001",
      blockId: "B-002",
      blockType: "implementation",
      title: "Follow-up",
      promptMarkdown: "follow-up body",
      dependsOn: ["B-001"]
    });
    expect(task(document, "T-001").blocks.at(-1)).toMatchObject({
      id: "B-002",
      depends_on: ["B-001"]
    });
    expect(document.promptMarkdownByPath["nodes/T-001/blocks/B-002.prompt.md"]).toBe(
      "follow-up body\n"
    );

    document = apply(document, {
      kind: "remove_block",
      blockRef: "T-001#B-002"
    });
    expect(document.promptMarkdownByPath["nodes/T-001/blocks/B-002.prompt.md"]).toBeUndefined();

    document = apply(document, {
      kind: "add_task_dependency",
      fromTaskId: "T-002",
      toTaskId: "T-001"
    });
    document = apply(document, {
      kind: "reconnect_task_dependency",
      fromTaskId: "T-002",
      oldToTaskId: "T-001",
      newToTaskId: "T-001"
    });
    expect(document.manifest.edges).toEqual([
      { type: "depends_on", from: "T-002", to: "T-001" }
    ]);
    document = apply(document, {
      kind: "remove_task_dependency",
      fromTaskId: "T-001",
      toTaskId: "T-002"
    });
    expect(document.manifest.edges).toHaveLength(1);

    document = apply(document, {
      kind: "remove_task",
      taskId: "T-002"
    });
    expect(document.manifest.nodes.map((node) => node.id)).toEqual(["T-001"]);
    expect(Object.keys(document.promptMarkdownByPath).some((path) => path.includes("T-002"))).toBe(false);
    expect(document.layout.nodes.map((node) => node.nodeId)).toEqual(["T-001"]);
  });

  it("creates default tasks and prompts with deterministic layout metadata", () => {
    const document = apply(baseDocument(), {
      kind: "add_task",
      taskId: "T-003",
      title: "Third task",
      promptMarkdown: "third body",
      blockPrompts: [{ blockId: "B-001", markdown: "implementation custom" }],
      layout: { nodeId: "T-003", x: 50, y: 60 },
      layoutUpdatedAt: "2026-08-02T02:00:00.000Z"
    });
    expect(task(document, "T-003")).toMatchObject({
      acceptance: ["Task is implemented."],
      blocks: [
        { id: "B-001", type: "implementation", depends_on: [] },
        { id: "R-001", type: "review", depends_on: ["B-001"] }
      ]
    });
    expect(document.promptMarkdownByPath["nodes/T-003/prompt.md"]).toBe("third body\n");
    expect(document.promptMarkdownByPath["nodes/T-003/blocks/B-001.prompt.md"]).toBe(
      "implementation custom\n"
    );
    expect(document.promptMarkdownByPath["nodes/T-003/blocks/R-001.prompt.md"]).toBe(
      "# Review work\n\nthird body\n"
    );
    expect(document.layout.nodes.at(-1)).toEqual({ nodeId: "T-003", x: 50, y: 60 });
    expect(document.layout.updatedAt).toBe("2026-08-02T02:00:00.000Z");
  });

  it("rejects ambiguous add-task associations and nondeterministic layout metadata", () => {
    const document = baseDocument();
    const invalidIntents: CanvasCommandIntent[] = [
      {
        kind: "add_task",
        taskId: "T-003",
        title: "Invalid prompt",
        promptMarkdown: "body",
        blockPrompts: [{ blockId: "B-999", markdown: "unknown" }]
      },
      {
        kind: "add_task",
        taskId: "T-003",
        title: "Duplicate prompt",
        promptMarkdown: "body",
        blockPrompts: [
          { blockId: "B-001", markdown: "first" },
          { blockId: "B-001", markdown: "second" }
        ]
      },
      {
        kind: "add_task",
        taskId: "T-003",
        title: "Wrong layout",
        promptMarkdown: "body",
        layout: { nodeId: "T-001", x: 1, y: 2 },
        layoutUpdatedAt: "2026-08-02T03:00:00.000Z"
      },
      {
        kind: "add_task",
        taskId: "T-003",
        title: "Missing timestamp",
        promptMarkdown: "body",
        layout: { nodeId: "T-003", x: 1, y: 2 }
      },
      {
        kind: "add_task",
        taskId: "T-003",
        title: "Missing layout",
        promptMarkdown: "body",
        layoutUpdatedAt: "2026-08-02T03:00:00.000Z"
      },
      {
        kind: "update_layout",
        nodes: [{ nodeId: "T-001", x: 1, y: 2 }]
      }
    ];
    for (const intent of invalidIntents) {
      expect(() => apply(document, intent)).toThrow();
    }
  });

  it("matches disk application for content, structural, and layout intents", async () => {
    const intents: CanvasCommandIntent[] = [
      {
        kind: "update_block_fields",
        blockRef: "T-001#B-001",
        fields: {
          title: "Conformant edit",
          promptMarkdown: "conformant prompt",
          sharedResources: ["database"],
          requiredCapabilities: ["network"]
        }
      },
      {
        kind: "update_layout",
        nodes: [{ nodeId: "T-001", x: 101, y: 202 }],
        updatedAt: "2026-08-02T04:00:00.000Z"
      },
      {
        kind: "add_task",
        taskId: "T-003",
        title: "Third task",
        promptMarkdown: "third task body",
        blockPrompts: [{ blockId: "R-001", markdown: "review body" }],
        layout: { nodeId: "T-003", x: 303, y: 404 },
        layoutUpdatedAt: "2026-08-02T05:00:00.000Z"
      },
      { kind: "remove_task", taskId: "T-002" },
      {
        kind: "bulk_update_blocks",
        updates: [
          {
            blockRef: "T-001#B-001",
            fields: { title: "Bulk title", promptMarkdown: "bulk prompt" }
          },
          {
            blockRef: "T-001#R-001",
            fields: { reviewRequired: false, maxFeedbackCycles: 2 }
          }
        ]
      },
      {
        kind: "add_task_dependency",
        fromTaskId: "T-002",
        toTaskId: "T-001"
      }
    ];
    for (const intent of intents) await expectDiskMatchesReplica(intent);
  });

  it("rejects the same invalid deterministic layout on disk and in memory", async () => {
    const intent: CanvasCommandIntent = {
      kind: "update_layout",
      nodes: [{ nodeId: "T-999", x: 1, y: 2 }],
      updatedAt: "2026-08-02T06:00:00.000Z"
    };
    expect(() => apply(baseDocument(), intent)).toThrow("canvas_layout_node_unknown:T-999");

    const workspace = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    directories.push(workspace.home, workspace.root);
    const applied = await applyAuthorizedCanvasCommand({
      projectRoot: workspace.init.workspace,
      canvasId: "default",
      authorityProjectId: "project-authority",
      intent
    });
    expect(applied).toMatchObject({
      ok: false,
      code: "invalid_command",
      detail: "canvas_layout_node_unknown:T-999"
    });
  });

  it("keeps manifest, prompts, and layout unchanged when staged layout writing fails", async () => {
    const workspace = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    directories.push(workspace.home, workspace.root);
    const authorityProjectId = "project-authority";
    const before = await captureAuthorizedCanvasContent({
      projectRoot: workspace.init.workspace,
      authorityProjectId
    });
    const loaded = await loadPackage(workspace.init.workspace);
    const layout = await getDesktopLayoutDirect(workspace.init.workspace);
    const application = buildCanvasCommandApplication(loaded.manifest, layout, {
      kind: "add_task",
      taskId: "T-003",
      title: "Must roll back",
      promptMarkdown: "rollback body",
      layout: { nodeId: "T-003", x: 3, y: 4 },
      layoutUpdatedAt: "2026-08-02T07:00:00.000Z"
    });

    await expect(
      commitCanvasCommandApplication({
        workspace: workspace.init.workspace,
        application,
        dependencies: {
          saveLayout: async () => {
            throw new Error("injected_layout_write_failure");
          }
        }
      })
    ).rejects.toThrow("injected_layout_write_failure");

    const after = await captureAuthorizedCanvasContent({
      projectRoot: workspace.init.workspace,
      authorityProjectId
    });
    expect(after.content).toEqual(before.content);
  });

  it("reports transaction cleanup failure after install without reporting command failure", async () => {
    const workspace = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    directories.push(workspace.home, workspace.root);
    const authorityProjectId = "project-authority";
    const before = await captureAuthorizedCanvasContent({
      projectRoot: workspace.init.workspace,
      authorityProjectId
    });
    const document = decodeCanvasReplicaDocument(before.content);
    const intent: CanvasCommandIntent = {
      kind: "update_task_fields",
      taskId: "T-001",
      fields: { title: "Installed despite cleanup warning" }
    };
    const expected = encodeCanvasReplicaDocument(apply(document, intent));
    const loaded = await loadPackage(workspace.init.workspace);
    const layout = await getDesktopLayoutDirect(workspace.init.workspace);
    const application = buildCanvasCommandApplication(loaded.manifest, layout, intent);
    const cleanupFailures: unknown[] = [];

    const result = await commitCanvasCommandApplication({
      workspace: workspace.init.workspace,
      application,
      dependencies: {
        cleanupCommittedTransaction: async () => {
          throw new Error("injected_cleanup_failure");
        },
        reportCleanupFailure: (error) => cleanupFailures.push(error)
      }
    });

    expect(result.ok).toBe(true);
    expect(cleanupFailures).toHaveLength(1);
    const after = await captureAuthorizedCanvasContent({
      projectRoot: workspace.init.workspace,
      authorityProjectId
    });
    expect(after.content).toEqual(expected);
    const recoveryRoot = join(
      workspace.init.workspace.workspaceRoot,
      "desktop",
      "recovery",
      "package-import"
    );
    const transactionIds = await readdir(recoveryRoot);
    expect(transactionIds).toHaveLength(1);
    await expect(
      rollbackPendingImportTransaction({
        workspaceRoot: workspace.init.workspace.workspaceRoot,
        transactionId: transactionIds[0]!
      })
    ).rejects.toThrow("Committed import transaction cannot be rolled back");
    await expect(
      listPendingImportTransactions(workspace.init.workspace.workspaceRoot)
    ).resolves.toEqual([]);
    await expect(readdir(recoveryRoot)).resolves.toEqual([]);
  });

  it("rolls back an installed package when the durable commit marker cannot be written", async () => {
    const workspace = await createTestWorkspace(basicManifest({ includeSecondTask: true }));
    directories.push(workspace.home, workspace.root);
    const authorityProjectId = "project-authority";
    const before = await captureAuthorizedCanvasContent({
      projectRoot: workspace.init.workspace,
      authorityProjectId
    });
    const loaded = await loadPackage(workspace.init.workspace);
    const layout = await getDesktopLayoutDirect(workspace.init.workspace);
    const application = buildCanvasCommandApplication(loaded.manifest, layout, {
      kind: "update_task_fields",
      taskId: "T-001",
      fields: { title: "Must not survive a failed commit marker" }
    });

    await expect(
      commitCanvasCommandApplication({
        workspace: workspace.init.workspace,
        application,
        dependencies: {
          markTransactionCommitted: async () => {
            throw new Error("injected_commit_marker_failure");
          }
        }
      })
    ).rejects.toThrow("injected_commit_marker_failure");

    const after = await captureAuthorizedCanvasContent({
      projectRoot: workspace.init.workspace,
      authorityProjectId
    });
    expect(after.content).toEqual(before.content);
    await expect(
      listPendingImportTransactions(workspace.init.workspace.workspaceRoot)
    ).resolves.toEqual([]);
  });
});
