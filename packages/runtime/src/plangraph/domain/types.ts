import type { BlockType } from "../../types.js";
import type { PlanGraphCommandDiagnostic } from "../commands.js";

export type TaskId = string;
export type BlockRef = string;
export type CanvasId = string;

export type PromptRef = {
  ownerKind: "task" | "block";
  ownerRef: string;
  path: string;
  contentHash: string;
  preview: string;
};

export type PlanGraphProject = {
  title: string;
  description: string;
};

export type PlanGraphTaskNode = {
  taskId: TaskId;
  canvasId: CanvasId | null;
  title: string;
  promptRef: PromptRef;
  acceptance: string[];
  executor: string | null;
  blockRefs: BlockRef[];
};

export type PlanGraphBlockNode = {
  ref: BlockRef;
  taskId: TaskId;
  blockId: string;
  type: BlockType;
  title: string;
  promptRef: PromptRef;
  executor: string | null;
  dependsOn: BlockRef[];
  requiredCapabilities: string[];
};

export type PlanGraphEdge =
  | { type: "taskDependsOn"; fromTaskId: TaskId; toTaskId: TaskId }
  | { type: "blockDependsOn"; fromBlockRef: BlockRef; toBlockRef: BlockRef };

export type PlanGraph = {
  graphVersion: string;
  packageFingerprint: string;
  project: PlanGraphProject;
  tasks: Map<TaskId, PlanGraphTaskNode>;
  blocks: Map<BlockRef, PlanGraphBlockNode>;
  edges: PlanGraphEdge[];
  promptRefs: Map<string, PromptRef>;
  diagnostics: PlanGraphCommandDiagnostic[];
};

export type PromptIndexEntry = PromptRef;
