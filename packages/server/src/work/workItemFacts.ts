import { blockRefSchema, type BlockRef } from "@planweave-ai/distributed-protocol";
import type { CompiledExecutionGraph, PlanPackageManifest } from "@planweave-ai/runtime";
import { compileTaskGraph, parseBlockRef } from "@planweave-ai/runtime";
import {
  workItemPackageFactsSchema,
  workItemRefSchema,
  type WorkItemPackageFacts,
  type WorkItemRef
} from "./schemas.js";

/**
 * Read-only port for resolving WorkItemRef against current Plan Package truth.
 * Implementations must not write package files; B-001 only defines the contract + pure adapters.
 */
export type WorkItemPackagePort = {
  resolveWorkItem(workItem: WorkItemRef): WorkItemPackageFacts;
};

/**
 * Build package facts from a compiled execution graph (authoritative indexes).
 * Canvas id is supplied by the caller (multi-canvas projects).
 */
export function workItemFactsFromCompiledGraph(
  graph: CompiledExecutionGraph,
  canvasId: string,
  workItem: WorkItemRef
): WorkItemPackageFacts {
  const parsedRef = workItemRefSchema.parse(workItem);
  if (parsedRef.canvasId !== canvasId) {
    return workItemPackageFactsSchema.parse({
      canvasId: parsedRef.canvasId,
      kind: parsedRef.kind,
      exists: false,
      taskId: parsedRef.kind === "task" ? parsedRef.taskId : undefined,
      blockRef: parsedRef.kind === "block" ? parsedRef.blockRef : undefined,
      requiredCapabilities: []
    });
  }

  if (parsedRef.kind === "task") {
    const task = graph.tasksById.get(parsedRef.taskId);
    return workItemPackageFactsSchema.parse({
      canvasId,
      kind: "task",
      exists: task !== undefined,
      taskId: parsedRef.taskId,
      requiredCapabilities: []
    });
  }

  const block = graph.blocksByRef.get(parsedRef.blockRef);
  if (!block) {
    return workItemPackageFactsSchema.parse({
      canvasId,
      kind: "block",
      exists: false,
      blockRef: parsedRef.blockRef,
      requiredCapabilities: []
    });
  }

  const requiredCapabilities =
    block.type === "implementation" ? [...(block.requirements?.capabilities ?? [])] : [];

  return workItemPackageFactsSchema.parse({
    canvasId,
    kind: "block",
    exists: true,
    blockRef: parsedRef.blockRef,
    taskId: graph.blockTaskByRef.get(parsedRef.blockRef),
    blockType: block.type,
    requiredCapabilities
  });
}

/** Pure adapter: compile an in-memory Plan Package manifest and resolve one WorkItemRef. */
export function workItemFactsFromManifest(
  manifest: PlanPackageManifest,
  canvasId: string,
  workItem: WorkItemRef
): WorkItemPackageFacts {
  const graph = compileTaskGraph(manifest);
  return workItemFactsFromCompiledGraph(graph, canvasId, workItem);
}

export function createCompiledGraphWorkItemPort(
  graph: CompiledExecutionGraph,
  canvasId: string
): WorkItemPackagePort {
  return {
    resolveWorkItem(workItem) {
      return workItemFactsFromCompiledGraph(graph, canvasId, workItem);
    }
  };
}

export function createManifestWorkItemPort(
  manifest: PlanPackageManifest,
  canvasId: string
): WorkItemPackagePort {
  const graph = compileTaskGraph(manifest);
  return createCompiledGraphWorkItemPort(graph, canvasId);
}

/**
 * Validate that a WorkItemRef exists in the current package facts.
 * Does not mutate Plan Package. Cross-canvas/project mismatches are treated as not found
 * at this port (callers enforce project id separately).
 */
export function validateWorkItemRef(
  port: WorkItemPackagePort,
  workItem: WorkItemRef
):
  | { ok: true; facts: WorkItemPackageFacts }
  | {
      ok: false;
      code: "work_item_not_found" | "work_input_invalid";
      facts?: WorkItemPackageFacts;
    } {
  const parsed = workItemRefSchema.safeParse(workItem);
  if (!parsed.success) {
    return { ok: false, code: "work_input_invalid" };
  }
  const facts = port.resolveWorkItem(parsed.data);
  if (!facts.exists) {
    return { ok: false, code: "work_item_not_found", facts };
  }
  if (facts.kind !== parsed.data.kind) {
    return { ok: false, code: "work_item_not_found", facts };
  }
  return { ok: true, facts };
}

/** Helper: portable block ref string → WorkItemRef block kind. */
export function blockWorkItemRef(canvasId: string, blockRef: string): WorkItemRef {
  return workItemRefSchema.parse({
    kind: "block",
    canvasId,
    blockRef: blockRefSchema.parse(blockRef)
  });
}

export function taskWorkItemRef(canvasId: string, taskId: string): WorkItemRef {
  return workItemRefSchema.parse({
    kind: "task",
    canvasId,
    taskId
  });
}

/** Split a validated block ref without filesystem assumptions. */
export function splitBlockRef(blockRef: BlockRef): { taskId: string; blockId: string } {
  return parseBlockRef(blockRef);
}
