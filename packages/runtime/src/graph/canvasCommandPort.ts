import { createHash } from "node:crypto";
import {
  canvasCommandIntentSchema,
  packageSnapshotDigestManifestSchema,
  type CanvasCommandIntent,
  type PackageSnapshotDigestManifest
} from "@planweave-ai/collaboration-contracts";
import {
  buildPlanPackageBlockFieldEditMutation,
  buildPlanPackageTaskFieldEditMutation
} from "./fieldEditMutation.js";
import {
  buildPlanPackageGraphMutation,
  buildPlanPackageManifestChangeMutation,
  type PlanPackageGraphMutation
} from "./mutation.js";
import { commitPlanPackageGraphMutation } from "./editGraph.js";
import { capturePackageSnapshot } from "../package/packageSnapshot.js";
import { loadPackage, resolvePackageWorkspace } from "../package/loadPackage.js";
import { resolveTaskCanvasWorkspace } from "../desktop/canvasApi.js";
import { getDesktopLayoutDirect, saveDesktopLayoutDirect } from "../desktop/layoutStore.js";
import type { ManifestBlock, ManifestTaskNode, PackageWorkspaceRef } from "../types.js";

/**
 * Narrow Server-facing port for authorized shared Canvas mutations.
 * Server injects ACL/scope/CAS before calling; Runtime owns package parsing and graph semantics.
 * Does not accept actor, absolute paths from clients, or free-form filesystem ops.
 */

export type ApplyAuthorizedCanvasCommandInput = {
  /** Authorized package workspace root (Server-resolved; never client-supplied trust). */
  projectRoot: PackageWorkspaceRef;
  canvasId: string;
  /** When set, refuse if resolved packageDir does not match the ACL-bound location. */
  expectedPackageDir?: string;
  intent: CanvasCommandIntent;
};

export type ApplyAuthorizedCanvasCommandSuccess = {
  ok: true;
  contentDigest: string;
  digestManifest: PackageSnapshotDigestManifest;
  packageDir: string;
  sizeBytes: number;
};

export type ApplyAuthorizedCanvasCommandFailure = {
  ok: false;
  code: "invalid_command" | "package_mismatch" | "mutation_failed";
  detail: string;
};

export type ApplyAuthorizedCanvasCommandResult =
  | ApplyAuthorizedCanvasCommandSuccess
  | ApplyAuthorizedCanvasCommandFailure;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

export function contentDigestFromManifest(manifest: PackageSnapshotDigestManifest): string {
  return createHash("sha256").update(stableStringify(manifest)).digest("hex");
}

function fail(
  code: ApplyAuthorizedCanvasCommandFailure["code"],
  detail: string
): ApplyAuthorizedCanvasCommandFailure {
  return { ok: false, code, detail };
}

function promptMarkdown(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function taskNode(manifest: Awaited<ReturnType<typeof loadPackage>>["manifest"], taskId: string) {
  const node = manifest.nodes.find(
    (candidate) => candidate.type === "task" && candidate.id === taskId
  );
  if (!node || node.type !== "task") return undefined;
  return node;
}

function buildDefaultTaskNode(
  intent: Extract<CanvasCommandIntent, { kind: "add_task" }>,
  maxFeedbackCycles: number
): {
  node: ManifestTaskNode;
  taskPromptMarkdown: string;
  blockPromptMarkdown: Array<{ blockId: string; markdown: string }>;
} {
  const blocks: ManifestBlock[] = [];
  const implementation: ManifestBlock = {
    id: "B-001",
    type: "implementation",
    title: "Implement work",
    prompt: `nodes/${intent.taskId}/blocks/B-001.prompt.md`,
    depends_on: []
  };
  if (intent.executor !== undefined) {
    implementation.executor = intent.executor;
  }
  blocks.push(implementation);
  const review: ManifestBlock = {
    id: "R-001",
    type: "review",
    title: "Review work",
    prompt: `nodes/${intent.taskId}/blocks/R-001.prompt.md`,
    depends_on: ["B-001"],
    review: { required: true, maxFeedbackCycles, hook: null }
  };
  blocks.push(review);

  const blockPromptById = new Map(
    (intent.blockPrompts ?? []).map((entry) => [entry.blockId, entry.markdown])
  );
  return {
    node: {
      id: intent.taskId,
      type: "task",
      title: intent.title,
      prompt: `nodes/${intent.taskId}/prompt.md`,
      executor: intent.executor,
      acceptance: intent.acceptance?.length ? intent.acceptance : ["Task is implemented."],
      blocks
    },
    taskPromptMarkdown: promptMarkdown(intent.promptMarkdown),
    blockPromptMarkdown: blocks.map((block) => ({
      blockId: block.id,
      markdown: promptMarkdown(
        blockPromptById.get(block.id) ?? `# ${block.title}\n\n${intent.promptMarkdown}`
      )
    }))
  };
}

function mutationFromIntent(
  loaded: Awaited<ReturnType<typeof loadPackage>>,
  intent: CanvasCommandIntent
): PlanPackageGraphMutation | ApplyAuthorizedCanvasCommandFailure {
  const { manifest } = loaded;
  switch (intent.kind) {
    case "add_task": {
      if (taskNode(manifest, intent.taskId)) {
        return fail("invalid_command", `task_exists:${intent.taskId}`);
      }
      const built = buildDefaultTaskNode(intent, manifest.review.maxFeedbackCycles);
      return buildPlanPackageGraphMutation(manifest, {
        kind: "addTaskNode",
        node: built.node,
        taskPromptMarkdown: built.taskPromptMarkdown,
        blockPromptMarkdown: built.blockPromptMarkdown
      });
    }
    case "remove_task": {
      if (!taskNode(manifest, intent.taskId)) {
        return fail("invalid_command", `task_missing:${intent.taskId}`);
      }
      return buildPlanPackageGraphMutation(manifest, {
        kind: "removeNode",
        nodeId: intent.taskId,
        removeTaskDirectory: true
      });
    }
    case "update_task_fields": {
      if (!taskNode(manifest, intent.taskId)) {
        return fail("invalid_command", `task_missing:${intent.taskId}`);
      }
      try {
        return buildPlanPackageTaskFieldEditMutation(manifest, {
          taskId: intent.taskId,
          title: intent.fields.title,
          promptMarkdown: intent.fields.promptMarkdown,
          executor: intent.fields.executor,
          acceptance: intent.fields.acceptance
        });
      } catch (error) {
        return fail(
          "invalid_command",
          error instanceof Error ? error.message : "task_field_edit_failed"
        );
      }
    }
    case "update_task_prompt": {
      if (!taskNode(manifest, intent.taskId)) {
        return fail("invalid_command", `task_missing:${intent.taskId}`);
      }
      try {
        return buildPlanPackageTaskFieldEditMutation(manifest, {
          taskId: intent.taskId,
          promptMarkdown: intent.promptMarkdown
        });
      } catch (error) {
        return fail(
          "invalid_command",
          error instanceof Error ? error.message : "task_prompt_edit_failed"
        );
      }
    }
    case "add_block": {
      const task = taskNode(manifest, intent.taskId);
      if (!task) return fail("invalid_command", `task_missing:${intent.taskId}`);
      if (task.blocks.some((block) => block.id === intent.blockId)) {
        return fail("invalid_command", `block_exists:${intent.taskId}#${intent.blockId}`);
      }
      const common = {
        id: intent.blockId,
        title: intent.title,
        prompt: `nodes/${intent.taskId}/blocks/${intent.blockId}.prompt.md`,
        depends_on: intent.dependsOn ?? [],
        executor: intent.executor
      };
      const block: ManifestBlock =
        intent.blockType === "review"
          ? {
              ...common,
              type: "review",
              review: {
                required: true,
                maxFeedbackCycles: manifest.review.maxFeedbackCycles,
                hook: null
              }
            }
          : { ...common, type: "implementation" };
      return buildPlanPackageGraphMutation(manifest, {
        kind: "addBlock",
        taskId: intent.taskId,
        block,
        promptMarkdown: promptMarkdown(intent.promptMarkdown)
      });
    }
    case "remove_block": {
      try {
        return buildPlanPackageGraphMutation(manifest, {
          kind: "removeBlock",
          blockRef: intent.blockRef
        });
      } catch (error) {
        return fail(
          "invalid_command",
          error instanceof Error ? error.message : "block_remove_failed"
        );
      }
    }
    case "update_block_fields": {
      try {
        return buildPlanPackageBlockFieldEditMutation(manifest, {
          blockRef: intent.blockRef,
          title: intent.fields.title,
          promptMarkdown: intent.fields.promptMarkdown,
          executor: intent.fields.executor,
          dependsOn: intent.fields.dependsOn,
          sharedResources: intent.fields.sharedResources,
          requiredCapabilities: intent.fields.requiredCapabilities,
          reviewRequired: intent.fields.reviewRequired,
          maxFeedbackCycles: intent.fields.maxFeedbackCycles
        });
      } catch (error) {
        return fail(
          "invalid_command",
          error instanceof Error ? error.message : "block_field_edit_failed"
        );
      }
    }
    case "update_block_prompt": {
      try {
        return buildPlanPackageBlockFieldEditMutation(manifest, {
          blockRef: intent.blockRef,
          promptMarkdown: intent.promptMarkdown
        });
      } catch (error) {
        return fail(
          "invalid_command",
          error instanceof Error ? error.message : "block_prompt_edit_failed"
        );
      }
    }
    case "add_task_dependency": {
      if (!taskNode(manifest, intent.fromTaskId) || !taskNode(manifest, intent.toTaskId)) {
        return fail("invalid_command", "task_dependency_endpoint_missing");
      }
      const exists = manifest.edges.some(
        (edge) =>
          edge.type === "depends_on" &&
          edge.from === intent.fromTaskId &&
          edge.to === intent.toTaskId
      );
      if (exists) return fail("invalid_command", "task_dependency_exists");
      return buildPlanPackageGraphMutation(manifest, {
        kind: "addEdge",
        edge: { type: "depends_on", from: intent.fromTaskId, to: intent.toTaskId }
      });
    }
    case "remove_task_dependency": {
      return buildPlanPackageGraphMutation(manifest, {
        kind: "removeEdge",
        edge: { type: "depends_on", from: intent.fromTaskId, to: intent.toTaskId }
      });
    }
    case "reconnect_task_dependency": {
      const fromTaskId = intent.newFromTaskId ?? intent.fromTaskId;
      if (!taskNode(manifest, fromTaskId) || !taskNode(manifest, intent.newToTaskId)) {
        return fail("invalid_command", "task_dependency_endpoint_missing");
      }
      const withoutOld = buildPlanPackageGraphMutation(manifest, {
        kind: "removeEdge",
        edge: { type: "depends_on", from: intent.fromTaskId, to: intent.oldToTaskId }
      });
      return buildPlanPackageGraphMutation(withoutOld.nextManifest, {
        kind: "addEdge",
        edge: { type: "depends_on", from: fromTaskId, to: intent.newToTaskId }
      });
    }
    case "bulk_update_blocks": {
      let nextManifest = manifest;
      const sideEffects: PlanPackageGraphMutation["sideEffects"] = [];
      const affected = new Set<string>();
      for (const update of intent.updates) {
        try {
          const mutation = buildPlanPackageBlockFieldEditMutation(nextManifest, {
            blockRef: update.blockRef,
            title: update.fields.title,
            promptMarkdown: update.fields.promptMarkdown,
            executor: update.fields.executor,
            dependsOn: update.fields.dependsOn,
            sharedResources: update.fields.sharedResources,
            requiredCapabilities: update.fields.requiredCapabilities,
            reviewRequired: update.fields.reviewRequired,
            maxFeedbackCycles: update.fields.maxFeedbackCycles
          });
          nextManifest = mutation.nextManifest;
          sideEffects.push(...mutation.sideEffects);
          for (const taskId of mutation.affectedTasks) affected.add(taskId);
        } catch (error) {
          return fail(
            "invalid_command",
            error instanceof Error ? error.message : "bulk_block_update_failed"
          );
        }
      }
      return buildPlanPackageManifestChangeMutation(manifest, nextManifest, {
        affectedTasks: [...affected],
        sideEffects
      });
    }
    case "update_layout":
      // Layout is applied outside package manifest mutations.
      return buildPlanPackageManifestChangeMutation(manifest, manifest, { sideEffects: [] });
    default: {
      const _exhaustive: never = intent;
      return fail("invalid_command", `unsupported_intent:${String((_exhaustive as { kind: string }).kind)}`);
    }
  }
}

async function applyLayoutUpdate(
  projectRoot: PackageWorkspaceRef,
  intent: Extract<CanvasCommandIntent, { kind: "update_layout" }>
): Promise<ApplyAuthorizedCanvasCommandFailure | undefined> {
  try {
    const layout = await getDesktopLayoutDirect(projectRoot);
    const byId = new Map(layout.nodes.map((node) => [node.nodeId, node]));
    for (const node of intent.nodes) {
      byId.set(node.nodeId, { nodeId: node.nodeId, x: node.x, y: node.y });
    }
    await saveDesktopLayoutDirect(projectRoot, {
      ...layout,
      nodes: [...byId.values()],
      updatedAt: new Date().toISOString()
    });
    return undefined;
  } catch (error) {
    return fail(
      "mutation_failed",
      error instanceof Error ? error.message : "layout_update_failed"
    );
  }
}

/**
 * Apply one authorized Canvas command intent against a Server-resolved package location.
 * Returns a content digest suitable for journal CAS and reconnect verification.
 */
export async function applyAuthorizedCanvasCommand(
  input: ApplyAuthorizedCanvasCommandInput
): Promise<ApplyAuthorizedCanvasCommandResult> {
  const intentResult = canvasCommandIntentSchema.safeParse(input.intent);
  if (!intentResult.success) {
    return fail("invalid_command", "intent_schema_invalid");
  }
  const intent = intentResult.data;

  let workspace: Awaited<ReturnType<typeof resolvePackageWorkspace>>;
  try {
    workspace =
      typeof input.projectRoot === "string"
        ? await resolveTaskCanvasWorkspace(input.projectRoot, input.canvasId)
        : await resolvePackageWorkspace(input.projectRoot);
  } catch (error) {
    return fail(
      "mutation_failed",
      error instanceof Error ? error.message : "package_workspace_unresolved"
    );
  }
  if (
    input.expectedPackageDir !== undefined &&
    workspace.packageDir !== input.expectedPackageDir
  ) {
    return fail("package_mismatch", "runtime_package_location_mismatch");
  }

  let loaded: Awaited<ReturnType<typeof loadPackage>>;
  try {
    loaded = await loadPackage(workspace);
  } catch (error) {
    return fail(
      "mutation_failed",
      error instanceof Error ? error.message : "package_load_failed"
    );
  }

  if (intent.kind === "update_layout") {
    const layoutError = await applyLayoutUpdate(workspace, intent);
    if (layoutError) return layoutError;
  } else {
    const mutation = mutationFromIntent(loaded, intent);
    if ("ok" in mutation && mutation.ok === false) return mutation;
    const graphMutation = mutation as PlanPackageGraphMutation;
    const commit = await commitPlanPackageGraphMutation({
      projectRoot: workspace,
      mutation: graphMutation
    });
    if (!commit.ok) {
      return fail(
        "mutation_failed",
        commit.diagnostics.map((item) => item.message).join("; ") || "graph_commit_failed"
      );
    }
    if (intent.kind === "add_task" && intent.layout) {
      const layoutError = await applyLayoutUpdate(workspace, {
        kind: "update_layout",
        nodes: [intent.layout]
      });
      if (layoutError) return layoutError;
    }
  }

  try {
    // Pass resolved workspace object only (no canvasId re-resolution that stringifies objects).
    const captured = await capturePackageSnapshot({
      projectRoot: workspace
    });
    if (captured.resolvedPackageDir !== workspace.packageDir) {
      return fail("package_mismatch", "runtime_package_location_mismatch");
    }
    const digestManifest = packageSnapshotDigestManifestSchema.parse(
      captured.snapshot.digestManifest
    );
    return {
      ok: true,
      contentDigest: contentDigestFromManifest(digestManifest),
      digestManifest,
      packageDir: workspace.packageDir,
      sizeBytes: digestManifest.totalBytes
    };
  } catch (error) {
    return fail(
      "mutation_failed",
      error instanceof Error ? error.message : "content_digest_failed"
    );
  }
}

/**
 * Read-only content digest for reconnect / CAS without applying a mutation.
 */
export async function readAuthorizedCanvasContentDigest(input: {
  projectRoot: PackageWorkspaceRef;
  canvasId: string;
  expectedPackageDir?: string;
}): Promise<ApplyAuthorizedCanvasCommandResult> {
  try {
    const workspace =
      typeof input.projectRoot === "string"
        ? await resolveTaskCanvasWorkspace(input.projectRoot, input.canvasId)
        : await resolvePackageWorkspace(input.projectRoot);
    if (
      input.expectedPackageDir !== undefined &&
      workspace.packageDir !== input.expectedPackageDir
    ) {
      return fail("package_mismatch", "runtime_package_location_mismatch");
    }
    const captured = await capturePackageSnapshot({
      projectRoot: workspace
    });
    if (captured.resolvedPackageDir !== workspace.packageDir) {
      return fail("package_mismatch", "runtime_package_location_mismatch");
    }
    const digestManifest = packageSnapshotDigestManifestSchema.parse(
      captured.snapshot.digestManifest
    );
    return {
      ok: true,
      contentDigest: contentDigestFromManifest(digestManifest),
      digestManifest,
      packageDir: workspace.packageDir,
      sizeBytes: digestManifest.totalBytes
    };
  } catch (error) {
    return fail(
      "mutation_failed",
      error instanceof Error ? error.message : "content_digest_failed"
    );
  }
}
