import type {
  DesktopAutoRunScope,
  DesktopAutoRunState,
  DesktopGraphViewModel,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import { useCallback, useEffect, useRef } from "react";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration";
import type { DesktopUiSettings } from "../../shared/desktopSettings";
import { createAgentEndpointBlockExecutor } from "../collaboration/agentEndpointBlockExecutor";
import { createAgentEndpointRunPlan } from "../collaboration/agentEndpointRunPlan";
import type { AvailableAgentEndpoint } from "../collaboration/agentEndpointViewModel";
import {
  type LocalAutoRunObserver,
  runAgentEndpointScope,
  waitForLocalAutoRunTerminal
} from "../collaboration/agentEndpointScopeRun";
import { waitForRemoteOperationTerminal } from "../collaboration/remoteTaskEndpointRun";
import { collaborationBridge } from "../bridge";

function createDispatchId(): string {
  return crypto.randomUUID();
}

type WorkspaceAgentEndpointRunInput = {
  activeProjectId: string | null;
  agentEndpoints: readonly AvailableAgentEndpoint[];
  collaborationController: {
    ensureWorkAuthority: (workItem: WorkItemRef) => Promise<{
      revisions: { responsibilityRevision: number; reviewerRevision: number };
    } | null>;
  } | null;
  graph: DesktopGraphViewModel | null;
  preferences: DesktopUiSettings["execution"]["agentEndpointPreferences"];
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setError: (message: string | null) => void;
  api?: Pick<
    PlanWeaveCollaborationApi,
    | "dispatchCollaborationRemoteOperation"
    | "observeCollaborationRemoteOperation"
    | "onCollaborationObserverSignal"
    | "readCollaborationCanvasRuntimeStatus"
  > | null;
  createId?: () => string;
  localAutoRunApi?: LocalAutoRunObserver | null;
  waitForLocalTerminal?: typeof waitForLocalAutoRunTerminal;
  waitForTerminal?: typeof waitForRemoteOperationTerminal;
};

export type LocalAutoRunScopeStarter = (
  scope: DesktopAutoRunScope
) => Promise<DesktopAutoRunState | null | undefined>;

export type WorkspaceAgentEndpointScopeStarter = (
  scope: DesktopAutoRunScope,
  startLocal: LocalAutoRunScopeStarter,
  lifecycle?: {
    onStarted: () => void;
    onCompleted: () => void;
    onFailed: (message: string) => void;
  }
) => Promise<void>;

export function useWorkspaceAgentEndpointRun(
  input: WorkspaceAgentEndpointRunInput
): WorkspaceAgentEndpointScopeStarter {
  const api = input.api === undefined ? collaborationBridge : input.api;
  const createId = input.createId ?? createDispatchId;
  const activeEndpointScopeRun = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      activeEndpointScopeRun.current?.abort();
    },
    []
  );

  return useCallback(
    async (scope: DesktopAutoRunScope, startLocal: LocalAutoRunScopeStarter, lifecycle) => {
      if (!input.graph || !input.selectedCanvasId) return;
      const plan = createAgentEndpointRunPlan({
        graph: input.graph,
        scope,
        endpoints: input.agentEndpoints,
        preferences: input.preferences,
        project: input.selectedProject,
        canvasId: input.selectedCanvasId
      });
      if (plan.kind === "noop") return;
      if (plan.kind === "rejected") {
        input.setError(plan.reason);
        return;
      }
      if (plan.kind === "local_scope") {
        await startLocal(plan.scope);
        return;
      }
      if (
        !input.activeProjectId ||
        !input.selectedProject ||
        !input.collaborationController ||
        !api
      ) {
        input.setError("collaboration_project_unavailable");
        return;
      }
      if (activeEndpointScopeRun.current) {
        input.setError("agent_endpoint_scope_run_already_active");
        return;
      }

      const controller = new AbortController();
      activeEndpointScopeRun.current = controller;
      lifecycle?.onStarted();
      const selectedProject = input.selectedProject;
      const selectedCanvasId = input.selectedCanvasId;
      try {
        const selectionByBlockRef =
          plan.kind === "coordinated_block"
            ? new Map([[plan.selection.block.ref, plan.selection]])
            : plan.selectionByBlockRef;
        const executeBlock = createAgentEndpointBlockExecutor({
          activeProjectId: input.activeProjectId,
          canvasId: selectedCanvasId,
          selectionByBlockRef,
          collaborationController: input.collaborationController,
          api,
          createId,
          startLocal,
          localAutoRunApi: input.localAutoRunApi,
          waitForLocalTerminal: input.waitForLocalTerminal,
          waitForRemoteTerminal: input.waitForTerminal
        });
        if (plan.kind === "coordinated_block") {
          await executeBlock(plan.selection.task, plan.selection.block, controller.signal);
          lifecycle?.onCompleted();
          return;
        }
        await runAgentEndpointScope({
          tasks: plan.tasks,
          readRuntimeStatus: () =>
            api.readCollaborationCanvasRuntimeStatus({
              localProjectId: selectedProject.projectId,
              canvasId: selectedCanvasId
            }),
          executeBlock: (task, block) => executeBlock(task, block, controller.signal),
          signal: controller.signal
        });
        lifecycle?.onCompleted();
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        input.setError(message);
        lifecycle?.onFailed(message);
      } finally {
        if (activeEndpointScopeRun.current === controller) activeEndpointScopeRun.current = null;
      }
    },
    [
      api,
      createId,
      input.activeProjectId,
      input.agentEndpoints,
      input.collaborationController,
      input.graph,
      input.localAutoRunApi,
      input.preferences,
      input.selectedCanvasId,
      input.selectedProject,
      input.setError,
      input.waitForLocalTerminal,
      input.waitForTerminal
    ]
  );
}
