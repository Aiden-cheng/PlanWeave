import {
  checkDesktopProjectDoctor,
  createProjectFromTaskCanvas,
  createTaskCanvas,
  duplicateTaskCanvas,
  getCanvasGraphViewModel,
  getCanvasMapLayout,
  getDesktopProjectSnapshot,
  getDesktopRuntimeRefresh,
  getProjectExecutionPlan,
  getProjectOverview,
  getStatistics,
  getTodoGroups,
  initOrOpenProject,
  linkProjectSourceRoot,
  listPendingImportRecoveries,
  listProjects,
  openProject,
  readGlobalPrompt,
  readProjectPrompt,
  readProjectPromptPolicy,
  removeProject,
  removeTaskCanvas,
  renameProject,
  renameTaskCanvas,
  repairDesktopProjectDoctor,
  resetCanvasMapLayout,
  rollbackPendingImportRecovery,
  saveCanvasMapLayout,
  searchProject,
  searchProjectWithDiagnostics,
  selectTaskCanvas,
  unlinkProjectSourceRoot,
  updateGlobalPrompt,
  updateProjectPrompt,
  updateProjectPromptPolicy
} from "@planweave-ai/runtime";
import type { RuntimeBridgeHandlerMap } from "./runtimeBridgeHandlerTypes.js";

export const runtimeBridgeProjectHandlers = {
  listProjects: () => listProjects(),
  checkProjectDoctor: (_event, reference) => checkDesktopProjectDoctor(reference),
  repairProjectDoctor: (_event, reference, confirmation) =>
    repairDesktopProjectDoctor(reference, confirmation),
  openProject: (_event, input) => openProject(input),
  initOrOpenProject: (_event, rootPath) => initOrOpenProject(rootPath),
  removeProject: (_event, projectId) => removeProject(projectId),
  renameProject: (_event, projectId, name) => renameProject(projectId, name),
  linkProjectSourceRoot: (_event, projectId, sourceRoot) =>
    linkProjectSourceRoot(projectId, sourceRoot),
  unlinkProjectSourceRoot: (_event, projectId) => unlinkProjectSourceRoot(projectId),
  createTaskCanvas: (_event, projectRoot, input) => createTaskCanvas(projectRoot, input),
  duplicateTaskCanvas: (_event, projectRoot, canvasId, input) =>
    duplicateTaskCanvas(projectRoot, canvasId, input),
  createProjectFromTaskCanvas: (_event, projectRoot, canvasId, input) =>
    createProjectFromTaskCanvas(projectRoot, canvasId, input),
  renameTaskCanvas: (_event, projectRoot, canvasId, name) =>
    renameTaskCanvas(projectRoot, canvasId, name),
  removeTaskCanvas: (_event, projectRoot, canvasId) => removeTaskCanvas(projectRoot, canvasId),
  selectTaskCanvas: (_event, projectRoot, canvasId) => selectTaskCanvas(projectRoot, canvasId),
  getProjectOverview: (_event, projectRoot) => getProjectOverview(projectRoot),
  getCanvasGraphViewModel: (_event, projectRoot) => getCanvasGraphViewModel(projectRoot),
  getCanvasMapLayout: (_event, projectRoot) => getCanvasMapLayout(projectRoot),
  // IPC payload is untrusted; runtime saveCanvasMapLayout parses with Zod.
  saveCanvasMapLayout: (_event, projectRoot: string, layout: unknown) =>
    saveCanvasMapLayout(projectRoot, layout),
  resetCanvasMapLayout: (_event, projectRoot) => resetCanvasMapLayout(projectRoot),
  getDesktopProjectSnapshot: (_event, ref) => getDesktopProjectSnapshot(ref),
  getDesktopRuntimeRefresh: (_event, ref) => getDesktopRuntimeRefresh(ref),
  getTodoGroups: (_event, projectRoot) => getTodoGroups(projectRoot),
  getProjectExecutionPlan: (_event, projectRoot) => getProjectExecutionPlan(projectRoot),
  readGlobalPrompt: () => readGlobalPrompt(),
  updateGlobalPrompt: (_event, markdown) => updateGlobalPrompt(markdown),
  readProjectPrompt: (_event, projectRoot) => readProjectPrompt(projectRoot),
  updateProjectPrompt: (_event, projectRoot, markdown) =>
    updateProjectPrompt(projectRoot, markdown),
  readProjectPromptPolicy: (_event, projectRoot) => readProjectPromptPolicy(projectRoot),
  updateProjectPromptPolicy: (_event, projectRoot, patch) =>
    updateProjectPromptPolicy(projectRoot, patch),
  listPendingImportRecoveries: (_event, projectRoot) => listPendingImportRecoveries(projectRoot),
  rollbackPendingImportRecovery: (_event, projectRoot, transactionId) =>
    rollbackPendingImportRecovery(projectRoot, transactionId),
  getStatistics: (_event, projectRoot) => getStatistics(projectRoot),
  searchProject: (_event, projectRoot, query, filters) =>
    searchProject(projectRoot, query, filters),
  searchProjectWithDiagnostics: (_event, projectRoot, query, filters) =>
    searchProjectWithDiagnostics(projectRoot, query, filters)
} satisfies Partial<RuntimeBridgeHandlerMap>;
