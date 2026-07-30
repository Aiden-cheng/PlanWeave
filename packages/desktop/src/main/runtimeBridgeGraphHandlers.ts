import {
  addBlock,
  addDependencyEdge,
  addTaskNode,
  applyCanvasLaneLayout,
  canvasExecutionPolicyInputSchema,
  cloneDesktopGraphEditResult,
  desktopAddBlockInputSchema,
  desktopAddTaskInputSchema,
  desktopCanvasReferenceSchema,
  desktopGraphEditValidationInputSchema,
  desktopLayoutFileSchema,
  desktopPromptSaveOptionsSchema,
  desktopUpdateReviewPipelineInputSchema,
  getDesktopGraphDiagnostics,
  getDesktopLayout,
  getFeedbackRecords,
  getGraphViewModel,
  getReviewAttempts,
  getReviewPipeline,
  getTaskDetail,
  reconnectDependencyEdge,
  redoDesktopPlanGraphCommand,
  removeBlock,
  removeDependencyEdge,
  removeTaskNode,
  resetDesktopLayout,
  saveDesktopLayout,
  undoDesktopPlanGraphCommand,
  updateBlockExecutor,
  updateBlockPrompt,
  updateBlockTitle,
  updateCanvasExecutionPolicy,
  updateReviewPipeline,
  updateTaskExecutor,
  updateTaskPrompt,
  updateTaskTitle,
  validateGraphEdit
} from "@planweave-ai/runtime";
import type { DesktopGraphEditResult, GraphEditResult } from "@planweave-ai/runtime";
import { resolveDesktopCanvasReference } from "./runtimeBridgeCanvasReference.js";
import type { RuntimeBridgeHandlerMap } from "./runtimeBridgeHandlerTypes.js";

async function invokeGraphEdit(promise: Promise<GraphEditResult>): Promise<DesktopGraphEditResult> {
  return cloneDesktopGraphEditResult(await promise);
}

export const runtimeBridgeGraphHandlers = {
  getDesktopGraphDiagnostics: async (_event, ref) =>
    getDesktopGraphDiagnostics(await resolveDesktopCanvasReference(ref)),
  getGraphViewModel: async (_event, ref) =>
    getGraphViewModel(await resolveDesktopCanvasReference(ref)),
  getTaskDetail: async (_event, ref, taskId) =>
    getTaskDetail(await resolveDesktopCanvasReference(ref), taskId),
  getReviewAttempts: async (_event, ref, blockRef) =>
    getReviewAttempts(await resolveDesktopCanvasReference(ref), blockRef),
  getFeedbackRecords: async (_event, ref, blockRef) =>
    getFeedbackRecords(await resolveDesktopCanvasReference(ref), blockRef),
  getReviewPipeline: async (_event, ref, taskId) =>
    getReviewPipeline(await resolveDesktopCanvasReference(ref), taskId),
  updateReviewPipeline: async (_event, ref, taskId, input) =>
    invokeGraphEdit(
      updateReviewPipeline(
        await resolveDesktopCanvasReference(desktopCanvasReferenceSchema.parse(ref)),
        taskId,
        desktopUpdateReviewPipelineInputSchema.parse(input)
      )
    ),
  addTaskNode: async (_event, ref, input) =>
    invokeGraphEdit(
      addTaskNode(
        await resolveDesktopCanvasReference(desktopCanvasReferenceSchema.parse(ref)),
        desktopAddTaskInputSchema.parse(input)
      )
    ),
  addBlock: async (_event, ref, input) =>
    invokeGraphEdit(
      addBlock(
        await resolveDesktopCanvasReference(desktopCanvasReferenceSchema.parse(ref)),
        desktopAddBlockInputSchema.parse(input)
      )
    ),
  removeTaskNode: async (_event, ref, taskId) =>
    invokeGraphEdit(removeTaskNode(await resolveDesktopCanvasReference(ref), taskId)),
  removeBlock: async (_event, ref, blockRef) =>
    invokeGraphEdit(removeBlock(await resolveDesktopCanvasReference(ref), blockRef)),
  validateGraphEdit: async (_event, ref, input) =>
    invokeGraphEdit(
      validateGraphEdit(
        await resolveDesktopCanvasReference(desktopCanvasReferenceSchema.parse(ref)),
        desktopGraphEditValidationInputSchema.parse(input)
      )
    ),
  updateTaskTitle: async (_event, ref, taskId, title) =>
    invokeGraphEdit(updateTaskTitle(await resolveDesktopCanvasReference(ref), taskId, title)),
  updateTaskPrompt: async (_event, ref, taskId, markdown, options) =>
    invokeGraphEdit(
      updateTaskPrompt(
        await resolveDesktopCanvasReference(desktopCanvasReferenceSchema.parse(ref)),
        taskId,
        markdown,
        options === undefined ? undefined : desktopPromptSaveOptionsSchema.parse(options)
      )
    ),
  updateBlockTitle: async (_event, ref, blockRef, title) =>
    invokeGraphEdit(updateBlockTitle(await resolveDesktopCanvasReference(ref), blockRef, title)),
  updateBlockPrompt: async (_event, ref, blockRef, markdown, options) =>
    invokeGraphEdit(
      updateBlockPrompt(
        await resolveDesktopCanvasReference(desktopCanvasReferenceSchema.parse(ref)),
        blockRef,
        markdown,
        options === undefined ? undefined : desktopPromptSaveOptionsSchema.parse(options)
      )
    ),
  updateTaskExecutor: async (_event, ref, taskId, executorName) =>
    invokeGraphEdit(
      updateTaskExecutor(await resolveDesktopCanvasReference(ref), taskId, executorName)
    ),
  updateBlockExecutor: async (_event, ref, blockRef, executorName) =>
    invokeGraphEdit(
      updateBlockExecutor(await resolveDesktopCanvasReference(ref), blockRef, executorName)
    ),
  updateCanvasExecutionPolicy: async (_event, ref, input) =>
    invokeGraphEdit(
      updateCanvasExecutionPolicy(
        await resolveDesktopCanvasReference(desktopCanvasReferenceSchema.parse(ref)),
        canvasExecutionPolicyInputSchema.parse(input)
      )
    ),
  addDependencyEdge: async (_event, ref, fromTaskId, toTaskId, baseGraphVersion, layoutSnapshot) =>
    invokeGraphEdit(
      addDependencyEdge(
        await resolveDesktopCanvasReference(desktopCanvasReferenceSchema.parse(ref)),
        fromTaskId,
        toTaskId,
        baseGraphVersion,
        layoutSnapshot === undefined ? undefined : desktopLayoutFileSchema.parse(layoutSnapshot)
      )
    ),
  removeDependencyEdge: async (
    _event,
    ref,
    fromTaskId,
    toTaskId,
    baseGraphVersion,
    layoutSnapshot
  ) =>
    invokeGraphEdit(
      removeDependencyEdge(
        await resolveDesktopCanvasReference(desktopCanvasReferenceSchema.parse(ref)),
        fromTaskId,
        toTaskId,
        baseGraphVersion,
        layoutSnapshot === undefined ? undefined : desktopLayoutFileSchema.parse(layoutSnapshot)
      )
    ),
  reconnectDependencyEdge: async (
    _event,
    ref,
    fromTaskId,
    oldToTaskId,
    newFromTaskId,
    newToTaskId,
    baseGraphVersion,
    layoutSnapshot
  ) =>
    invokeGraphEdit(
      reconnectDependencyEdge(
        await resolveDesktopCanvasReference(desktopCanvasReferenceSchema.parse(ref)),
        fromTaskId,
        oldToTaskId,
        newFromTaskId,
        newToTaskId,
        baseGraphVersion,
        layoutSnapshot === undefined ? undefined : desktopLayoutFileSchema.parse(layoutSnapshot)
      )
    ),
  undoPlanGraphCommand: async (_event, ref) =>
    invokeGraphEdit(undoDesktopPlanGraphCommand(await resolveDesktopCanvasReference(ref))),
  redoPlanGraphCommand: async (_event, ref) =>
    invokeGraphEdit(redoDesktopPlanGraphCommand(await resolveDesktopCanvasReference(ref))),
  getDesktopLayout: async (_event, ref) =>
    getDesktopLayout(await resolveDesktopCanvasReference(ref)),
  saveDesktopLayout: async (_event, ref, layout) =>
    saveDesktopLayout(
      await resolveDesktopCanvasReference(desktopCanvasReferenceSchema.parse(ref)),
      desktopLayoutFileSchema.parse(layout)
    ),
  resetDesktopLayout: async (_event, ref) =>
    resetDesktopLayout(await resolveDesktopCanvasReference(ref)),
  applyCanvasLaneLayout: async (_event, ref) =>
    applyCanvasLaneLayout(await resolveDesktopCanvasReference(ref))
} satisfies Partial<RuntimeBridgeHandlerMap>;
