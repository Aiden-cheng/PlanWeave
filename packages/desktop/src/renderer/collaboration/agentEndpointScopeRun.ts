import type { CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-protocol/canvas/status";
import type {
  DesktopAutoRunEvent,
  DesktopAutoRunState,
  DesktopGraphViewModel
} from "@planweave-ai/runtime";

const TERMINAL_LOCAL_PHASES = new Set<DesktopAutoRunState["phase"]>([
  "completed",
  "blocked",
  "failed",
  "stopped"
]);

type DesktopGraphTask = DesktopGraphViewModel["tasks"][number];
type DesktopGraphBlock = DesktopGraphTask["blocks"][number];

export type LocalAutoRunObserver = {
  getAutoRunState: (runId: string) => Promise<DesktopAutoRunState>;
  onAutoRunChanged: (callback: (event: DesktopAutoRunEvent) => void) => () => void;
};

export function waitForLocalAutoRunTerminal(input: {
  api: LocalAutoRunObserver;
  initial: DesktopAutoRunState;
  signal?: AbortSignal;
  fallbackRefreshMs?: number;
}): Promise<DesktopAutoRunState> {
  if (TERMINAL_LOCAL_PHASES.has(input.initial.phase)) return Promise.resolve(input.initial);

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
    const finish = (state: DesktopAutoRunState) => {
      cleanup();
      resolve(state);
    };
    const fail = (reason: unknown) => {
      cleanup();
      reject(reason);
    };
    const scheduleFallback = () => {
      if (settled) return;
      timer = setTimeout(() => void refresh(), input.fallbackRefreshMs ?? 1_000);
    };
    const refresh = async () => {
      if (settled || refreshInFlight) return;
      refreshInFlight = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        const state = await input.api.getAutoRunState(input.initial.runId);
        if (TERMINAL_LOCAL_PHASES.has(state.phase)) {
          finish(state);
          return;
        }
        scheduleFallback();
      } catch (caught) {
        fail(caught);
      } finally {
        refreshInFlight = false;
      }
    };
    const onAbort = () => fail(new Error("agent_endpoint_scope_run_cancelled"));
    const unsubscribe = input.api.onAutoRunChanged((event) => {
      if (event.runId !== input.initial.runId) return;
      if (TERMINAL_LOCAL_PHASES.has(event.state.phase)) {
        finish(event.state);
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

function describeUnavailableScope(
  status: CanvasRuntimeStatusProjection,
  tasks: readonly DesktopGraphTask[]
): string {
  const blockRefs = new Set(tasks.flatMap((task) => task.blocks.map((block) => block.ref)));
  const blocking = status.blocks.find(
    (block) =>
      blockRefs.has(block.ref) && (block.status === "blocked" || block.status === "diverged")
  );
  if (blocking?.blockedReason) return blocking.blockedReason;
  if (blocking?.divergenceReason) return blocking.divergenceReason;
  if (status.blocks.some((block) => blockRefs.has(block.ref) && block.status === "in_progress")) {
    return "agent_endpoint_scope_has_in_progress_block";
  }
  return "agent_endpoint_scope_has_no_dispatchable_block";
}

export async function runAgentEndpointScope(input: {
  tasks: readonly DesktopGraphTask[];
  readRuntimeStatus: () => Promise<CanvasRuntimeStatusProjection | null>;
  executeBlock: (task: DesktopGraphTask, block: DesktopGraphBlock) => Promise<void>;
  signal?: AbortSignal;
}): Promise<void> {
  const taskIds = new Set(input.tasks.map((task) => task.taskId));
  while (!input.signal?.aborted) {
    const status = await input.readRuntimeStatus();
    if (!status) throw new Error("collaboration_runtime_status_unavailable");
    const taskStatusById = new Map(status.tasks.map((task) => [task.taskId, task]));
    for (const task of input.tasks) {
      if (!taskStatusById.has(task.taskId)) {
        throw new Error(`collaboration_runtime_task_status_unavailable:${task.taskId}`);
      }
    }
    if (
      status.tasks
        .filter((task) => taskIds.has(task.taskId))
        .every((task) => task.status === "implemented")
    ) {
      return;
    }

    const statusByBlockRef = new Map(status.blocks.map((block) => [block.ref, block]));
    const next = input.tasks
      .flatMap((task) => task.blocks.map((block) => ({ task, block })))
      .find(({ block }) => statusByBlockRef.get(block.ref)?.dispatchable === true);
    if (!next) throw new Error(describeUnavailableScope(status, input.tasks));
    await input.executeBlock(next.task, next.block);
  }
  throw new Error("agent_endpoint_scope_run_cancelled");
}
