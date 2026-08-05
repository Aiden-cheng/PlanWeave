import { useCallback, useEffect, useRef } from "react";
import type {
  DesktopAutoRunScope,
  DesktopGraphViewModel,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { AvailableAgentEndpoint } from "../collaboration/agentEndpointViewModel";
import {
  applyAgentEndpointRequirements
} from "../collaboration/agentEndpointViewModel";
import {
  agentEndpointPreferenceKey,
  selectedAgentEndpointId
} from "../collaboration/agentEndpointPreferences";
import type { DesktopUiSettings } from "../../shared/desktopSettings";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration";
import { collaborationBridge } from "../bridge";
import {
  runRemoteTaskEndpoint,
  waitForRemoteOperationTerminal
} from "../collaboration/remoteTaskEndpointRun";

function createDispatchId(): string {
  return crypto.randomUUID();
}

export function useWorkspaceAgentEndpointRun(input: {
  activeProjectId: string | null;
  agentEndpoints: readonly AvailableAgentEndpoint[];
  collaborationController: {
    ensureWorkAuthority: (workItem: WorkItemRef) => Promise<{
      revisions: {
        responsibilityRevision: number;
        reviewerRevision: number;
      };
    } | null>;
  } | null;
  graph: DesktopGraphViewModel | null;
  preferences: DesktopUiSettings["execution"]["agentEndpointPreferences"];
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setError: (message: string | null) => void;
  startLocal: (scope: DesktopAutoRunScope) => Promise<void>;
  api?: Pick<
    PlanWeaveCollaborationApi,
    | "dispatchCollaborationRemoteOperation"
    | "observeCollaborationRemoteOperation"
    | "onCollaborationObserverSignal"
    | "readCollaborationCanvasRuntimeStatus"
  > | null;
  createId?: () => string;
  waitForTerminal?: typeof waitForRemoteOperationTerminal;
}): (scope: DesktopAutoRunScope) => Promise<void> {
  const api = input.api === undefined ? collaborationBridge : input.api;
  const createId = input.createId ?? createDispatchId;
  const activeRemoteTaskRun = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      activeRemoteTaskRun.current?.abort();
    },
    []
  );

  return useCallback(
    async (scope: DesktopAutoRunScope) => {
      if (!input.graph || !input.selectedCanvasId) return;
      if (scope.kind === "project") {
        await input.startLocal(scope);
        return;
      }
      const task =
        scope.kind === "task"
          ? input.graph.tasks.find((candidate) => candidate.taskId === scope.taskId)
          : input.graph.tasks.find((candidate) =>
              candidate.blocks.some((block) => block.ref === scope.blockRef)
            );
      if (!task) return;
      const block =
        scope.kind === "block"
          ? task.blocks.find((candidate) => candidate.ref === scope.blockRef)
          : null;
      const executorName = block?.executor ?? task.executorLabel;
      const preferenceKey = input.selectedProject
        ? agentEndpointPreferenceKey({
            projectRoot: input.selectedProject.rootPath,
            canvasId: input.selectedCanvasId,
            scope: block?.executor
              ? { kind: "block", blockRef: block.ref }
              : { kind: "task", taskId: task.taskId }
          })
        : null;
      const endpointId = selectedAgentEndpointId({
        executorName,
        preference: preferenceKey ? input.preferences[preferenceKey] : undefined
      });
      const requiredCapabilities =
        block?.requiredCapabilities ??
        [...new Set(task.blocks.flatMap((candidate) => candidate.requiredCapabilities))];
      const endpoint = applyAgentEndpointRequirements(
        input.agentEndpoints,
        requiredCapabilities
      ).find((candidate) => candidate.id === endpointId);
      if (!endpoint?.available) {
        input.setError(endpoint?.unavailableReason ?? "agent_endpoint_selection_unavailable");
        return;
      }
      if (endpoint.source === "local") {
        await input.startLocal(scope);
        return;
      }
      if (
        !endpoint.remoteEndpointId ||
        !input.activeProjectId ||
        !input.collaborationController ||
        !api
      ) {
        input.setError("collaboration_project_unavailable");
        return;
      }
      const activeProjectId = input.activeProjectId;
      const collaborationController = input.collaborationController;
      const remoteEndpointId = endpoint.remoteEndpointId;
      const selectedCanvasId = input.selectedCanvasId;
      try {
        const dispatchBlock = async (blockRef: string) => {
          const workItem = {
            kind: "block" as const,
            canvasId: selectedCanvasId,
            blockRef
          };
          const authority = await collaborationController.ensureWorkAuthority(workItem);
          if (!authority) throw new Error("work_authority_unavailable");
          return api.dispatchCollaborationRemoteOperation({
            schemaVersion: "remote-run/v3",
            projectId: activeProjectId,
            canvasId: selectedCanvasId,
            blockRef,
            agentEndpointId: remoteEndpointId,
            idempotencyKey: `desktop-dispatch-${createId()}`,
            expectedResponsibilityRevision: authority.revisions.responsibilityRevision,
            expectedReviewerRevision: authority.revisions.reviewerRevision
          });
        };
        if (scope.kind === "block") {
          await dispatchBlock(scope.blockRef);
          return;
        }
        if (!input.selectedProject) throw new Error("collaboration_project_unavailable");
        const selectedProject = input.selectedProject;
        if (activeRemoteTaskRun.current) throw new Error("remote_task_run_already_active");
        const controller = new AbortController();
        activeRemoteTaskRun.current = controller;
        try {
          await runRemoteTaskEndpoint({
            task,
            readRuntimeStatus: () =>
              api.readCollaborationCanvasRuntimeStatus({
                localProjectId: selectedProject.projectId,
                canvasId: selectedCanvasId
              }),
            dispatchBlock,
            waitForTerminal: (observation, signal) =>
              (input.waitForTerminal ?? waitForRemoteOperationTerminal)({
                api,
                initial: observation,
                signal
              }),
            signal: controller.signal
          });
        } finally {
          if (activeRemoteTaskRun.current === controller) activeRemoteTaskRun.current = null;
        }
      } catch (caught) {
        input.setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [
      api,
      input.activeProjectId,
      input.agentEndpoints,
      input.collaborationController,
      createId,
      input.graph,
      input.preferences,
      input.selectedCanvasId,
      input.selectedProject,
      input.setError,
      input.startLocal,
      input.waitForTerminal
    ]
  );
}
