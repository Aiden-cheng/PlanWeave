import { useEffect, useMemo, useState } from "react";
import type { CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-contracts";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration";
import { collaborationBridge } from "../bridge";

export const COLLABORATION_RUNTIME_STATUS_POLL_MS = 3_000;

export type CollaborationRuntimeStatusBridge = Pick<
  PlanWeaveCollaborationApi,
  "readCollaborationCanvasRuntimeStatus"
>;

export function mergeCollaborationRuntimeStatus(
  graph: DesktopGraphViewModel,
  status: CanvasRuntimeStatusProjection | null
): DesktopGraphViewModel {
  if (!status || status.packageFingerprint !== graph.packageFingerprint) return graph;
  const taskStatuses = new Map(status.tasks.map((task) => [task.taskId, task]));
  const blockStatuses = new Map(status.blocks.map((block) => [block.ref, block]));
  return {
    ...graph,
    tasks: graph.tasks.map((task) => {
      const remoteTask = taskStatuses.get(task.taskId);
      const mergeBlocks = (blocks: typeof task.blocks) =>
        blocks.map((block) => {
          const remoteBlock = blockStatuses.get(block.ref);
          if (!remoteBlock) return block;
          return {
            ...block,
            status: remoteBlock.status,
            exceptionReason: remoteBlock.blockedReason ?? remoteBlock.divergenceReason ?? null
          };
        });
      const exceptions = status.blocks.flatMap((block) => {
        if (!block.ref.startsWith(`${task.taskId}#`)) return [];
        const reason = block.blockedReason ?? block.divergenceReason;
        if (!reason || (block.status !== "blocked" && block.status !== "diverged")) return [];
        return [{ ref: block.ref, reason, source: block.status }];
      });
      return {
        ...task,
        status: remoteTask?.status ?? task.status,
        blocks: mergeBlocks(task.blocks),
        blockPreview: mergeBlocks(task.blockPreview),
        exceptions
      };
    })
  };
}

export function useCollaborationRuntimeStatus(input: {
  enabled: boolean;
  sessionConnected: boolean;
  localProjectId: string | null;
  localCanvasId: string | null;
  graph: DesktopGraphViewModel | null;
  api?: CollaborationRuntimeStatusBridge | null;
}): { graph: DesktopGraphViewModel | null; error: string | null } {
  const api = input.api === undefined ? collaborationBridge : input.api;
  const [status, setStatus] = useState<CanvasRuntimeStatusProjection | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (
      !api ||
      !input.enabled ||
      !input.sessionConnected ||
      !input.localProjectId ||
      !input.localCanvasId ||
      !input.graph
    ) {
      setStatus(null);
      setError(null);
      return undefined;
    }
    const localProjectId = input.localProjectId;
    const localCanvasId = input.localCanvasId;
    const packageFingerprint = input.graph.packageFingerprint;
    let active = true;
    let inFlight = false;
    const refresh = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      try {
        const next = await api.readCollaborationCanvasRuntimeStatus({
          localProjectId,
          canvasId: localCanvasId
        });
        if (!active) return;
        setStatus(next?.packageFingerprint === packageFingerprint ? next : null);
        setError(null);
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const intervalId = setInterval(() => void refresh(), COLLABORATION_RUNTIME_STATUS_POLL_MS);
    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, [
    api,
    input.enabled,
    input.graph?.packageFingerprint,
    input.localCanvasId,
    input.localProjectId,
    input.sessionConnected
  ]);

  return useMemo(
    () => ({
      graph: input.graph ? mergeCollaborationRuntimeStatus(input.graph, status) : null,
      error
    }),
    [error, input.graph, status]
  );
}
