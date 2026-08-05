import type { CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-protocol/canvas/status";
import type { RemoteOperationObservation } from "@planweave-ai/collaboration-protocol/remote-run";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import type { CollaborationObserverSignal } from "../../shared/collaborationReadModels";

const TERMINAL_OPERATION_STATES = new Set<RemoteOperationObservation["state"]>([
  "completed",
  "failed",
  "cancelled"
]);

export type RemoteOperationObserver = {
  observeCollaborationRemoteOperation: (input: {
    operationId: string;
  }) => Promise<RemoteOperationObservation>;
  onCollaborationObserverSignal: (
    callback: (signal: CollaborationObserverSignal) => void
  ) => () => void;
};

export function waitForRemoteOperationTerminal(input: {
  api: RemoteOperationObserver;
  initial: RemoteOperationObservation;
  signal?: AbortSignal;
  fallbackRefreshMs?: number;
}): Promise<RemoteOperationObservation> {
  if (TERMINAL_OPERATION_STATES.has(input.initial.state)) return Promise.resolve(input.initial);

  return new Promise((resolve, reject) => {
    let settled = false;
    let refreshInFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      settled = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (observation: RemoteOperationObservation) => {
      cleanup();
      resolve(observation);
    };
    const fail = (reason: unknown) => {
      cleanup();
      reject(reason);
    };
    const scheduleFallback = () => {
      if (settled) return;
      timer = setTimeout(() => void refresh(), input.fallbackRefreshMs ?? 10_000);
    };
    const refresh = async () => {
      if (settled || refreshInFlight) return;
      refreshInFlight = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        const observation = await input.api.observeCollaborationRemoteOperation({
          operationId: input.initial.operationId
        });
        if (TERMINAL_OPERATION_STATES.has(observation.state)) {
          finish(observation);
          return;
        }
        scheduleFallback();
      } catch (caught) {
        fail(caught);
      } finally {
        refreshInFlight = false;
      }
    };
    const onAbort = () => fail(new Error("remote_task_run_cancelled"));
    const unsubscribe = input.api.onCollaborationObserverSignal((signal) => {
      if (
        signal.type === "human.observer.event" &&
        signal.event.kind === "remote_run" &&
        signal.event.dispatchId === input.initial.dispatchId
      ) {
        void refresh();
      }
    });

    if (input.signal?.aborted) {
      onAbort();
      return;
    }
    input.signal?.addEventListener("abort", onAbort, { once: true });
    void refresh();
  });
}

type DesktopGraphTask = DesktopGraphViewModel["tasks"][number];

function describeUnavailableTask(status: CanvasRuntimeStatusProjection, task: DesktopGraphTask) {
  const taskBlocks = new Set(task.blocks.map((block) => block.ref));
  const blocking = status.blocks.find(
    (block) =>
      taskBlocks.has(block.ref) &&
      (block.status === "blocked" || block.status === "diverged")
  );
  if (blocking?.blockedReason) return blocking.blockedReason;
  if (blocking?.divergenceReason) return blocking.divergenceReason;
  if (status.blocks.some((block) => taskBlocks.has(block.ref) && block.status === "in_progress")) {
    return "remote_task_has_in_progress_block";
  }
  return "remote_task_has_no_dispatchable_block";
}

export async function runRemoteTaskEndpoint(input: {
  task: DesktopGraphTask;
  readRuntimeStatus: () => Promise<CanvasRuntimeStatusProjection | null>;
  dispatchBlock: (blockRef: string) => Promise<RemoteOperationObservation>;
  waitForTerminal: (
    observation: RemoteOperationObservation,
    signal?: AbortSignal
  ) => Promise<RemoteOperationObservation>;
  signal?: AbortSignal;
}): Promise<void> {
  while (!input.signal?.aborted) {
    const status = await input.readRuntimeStatus();
    if (!status) throw new Error("collaboration_runtime_status_unavailable");
    const taskStatus = status.tasks.find((candidate) => candidate.taskId === input.task.taskId);
    if (!taskStatus) throw new Error("collaboration_runtime_task_status_unavailable");
    if (taskStatus.status === "implemented") return;

    const statusByBlockRef = new Map(status.blocks.map((block) => [block.ref, block]));
    const nextBlock = input.task.blocks.find(
      (block) => statusByBlockRef.get(block.ref)?.dispatchable === true
    );
    if (!nextBlock) throw new Error(describeUnavailableTask(status, input.task));

    const dispatched = await input.dispatchBlock(nextBlock.ref);
    const terminal = await input.waitForTerminal(dispatched, input.signal);
    if (terminal.state !== "completed") {
      throw new Error(`remote_task_block_${terminal.state}:${nextBlock.ref}`);
    }
  }
  throw new Error("remote_task_run_cancelled");
}
