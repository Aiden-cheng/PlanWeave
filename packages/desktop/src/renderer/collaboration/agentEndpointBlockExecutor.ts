import type { DesktopAutoRunState, DesktopGraphViewModel } from "@planweave-ai/runtime";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration";
import { bridge } from "../bridge";
import type { AgentEndpointBlockSelection } from "./agentEndpointRunPlan";
import { type LocalAutoRunObserver, waitForLocalAutoRunTerminal } from "./agentEndpointScopeRun";
import { waitForRemoteOperationTerminal } from "./remoteTaskEndpointRun";

type GraphTask = DesktopGraphViewModel["tasks"][number];
type GraphBlock = GraphTask["blocks"][number];
type RemoteOperationsApi = Pick<
  PlanWeaveCollaborationApi,
  | "dispatchCollaborationRemoteOperation"
  | "observeCollaborationRemoteOperation"
  | "onCollaborationObserverSignal"
>;

export function createAgentEndpointBlockExecutor(input: {
  activeProjectId: string;
  canvasId: string;
  selectionByBlockRef: ReadonlyMap<string, AgentEndpointBlockSelection>;
  collaborationController: {
    ensureWorkAuthority: (workItem: WorkItemRef) => Promise<{
      revisions: { responsibilityRevision: number; reviewerRevision: number };
    } | null>;
  };
  api: RemoteOperationsApi;
  createId: () => string;
  startLocal: (scope: {
    kind: "block";
    blockRef: string;
  }) => Promise<DesktopAutoRunState | null | undefined>;
  localAutoRunApi?: LocalAutoRunObserver | null;
  waitForLocalTerminal?: typeof waitForLocalAutoRunTerminal;
  waitForRemoteTerminal?: typeof waitForRemoteOperationTerminal;
}): (task: GraphTask, block: GraphBlock, signal?: AbortSignal) => Promise<void> {
  const executeLocal = async (selection: AgentEndpointBlockSelection, signal?: AbortSignal) => {
    const started = await input.startLocal({ kind: "block", blockRef: selection.block.ref });
    if (!started) throw new Error(`local_agent_run_not_started:${selection.block.ref}`);
    const localApi = input.localAutoRunApi === undefined ? bridge : input.localAutoRunApi;
    if (!localApi) throw new Error("desktop_bridge_unavailable");
    const terminal = await (input.waitForLocalTerminal ?? waitForLocalAutoRunTerminal)({
      api: localApi,
      initial: started,
      signal
    });
    if (terminal.phase !== "completed") {
      throw new Error(`local_agent_block_${terminal.phase}:${selection.block.ref}`);
    }
  };

  const executeRemote = async (selection: AgentEndpointBlockSelection, signal?: AbortSignal) => {
    const existingExecution = selection.block.remoteExecution;
    if (existingExecution && existingExecution.phase !== "terminal") {
      const existing = await input.api.observeCollaborationRemoteOperation({
        operationId: existingExecution.identity.operationId
      });
      const terminal = await (input.waitForRemoteTerminal ?? waitForRemoteOperationTerminal)({
        api: input.api,
        initial: existing,
        signal
      });
      if (terminal.state === "completed") return;
      if (terminal.failure) {
        throw new Error(`${terminal.failure.message} (${terminal.failure.code})`);
      }
      throw new Error(`remote_agent_block_${terminal.state}:${selection.block.ref}`);
    }
    const remoteEndpointId = selection.endpoint.remoteEndpointId;
    if (!remoteEndpointId) throw new Error("collaboration_project_unavailable");
    const authority = await input.collaborationController.ensureWorkAuthority({
      kind: "block",
      canvasId: input.canvasId,
      blockRef: selection.block.ref
    });
    if (!authority) throw new Error("work_authority_unavailable");
    const dispatched = await input.api.dispatchCollaborationRemoteOperation({
      schemaVersion: "remote-run/v3",
      projectId: input.activeProjectId,
      canvasId: input.canvasId,
      blockRef: selection.block.ref,
      agentEndpointId: remoteEndpointId,
      idempotencyKey: `desktop-dispatch-${input.createId()}`,
      expectedResponsibilityRevision: authority.revisions.responsibilityRevision,
      expectedReviewerRevision: authority.revisions.reviewerRevision
    });
    const terminal = await (input.waitForRemoteTerminal ?? waitForRemoteOperationTerminal)({
      api: input.api,
      initial: dispatched,
      signal
    });
    if (terminal.state !== "completed") {
      if (terminal.failure) {
        throw new Error(`${terminal.failure.message} (${terminal.failure.code})`);
      }
      throw new Error(`remote_agent_block_${terminal.state}:${selection.block.ref}`);
    }
  };

  const adapters = { local: executeLocal, remote: executeRemote };
  return async (_task, block, signal) => {
    const selection = input.selectionByBlockRef.get(block.ref);
    if (!selection) throw new Error(`agent_endpoint_selection_missing:${block.ref}`);
    await adapters[selection.endpoint.source](selection, signal);
  };
}
