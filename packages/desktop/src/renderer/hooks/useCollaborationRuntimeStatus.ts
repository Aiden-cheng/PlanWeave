import { useEffect, useMemo, useState } from "react";
import type { CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-contracts";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration";
import { collaborationBridge } from "../bridge";

export const COLLABORATION_RUNTIME_STATUS_POLL_MS = 3_000;

export type CollaborationRuntimeStatusBridge = Pick<
  PlanWeaveCollaborationApi,
  "readCollaborationCanvasRuntimeStatus" | "resolveCollaborationCanvasScope"
>;

type ResolvedCanvasIdentity = {
  profileId: string;
  localProjectId: string;
  localCanvasId: string;
  remoteWorkspaceId: CanvasRuntimeStatusProjection["scope"]["workspaceId"];
  remoteProjectId: string;
  remoteCanvasId: string;
};

type RuntimeStatusSnapshot = {
  identity: ResolvedCanvasIdentity;
  status: CanvasRuntimeStatusProjection;
};

function sameRuntimeScope(
  left: CanvasRuntimeStatusProjection["scope"],
  right: CanvasRuntimeStatusProjection["scope"]
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.canvasId === right.canvasId
  );
}

function matchesResolvedCanvas(
  status: CanvasRuntimeStatusProjection,
  identity: ResolvedCanvasIdentity
): boolean {
  return (
    status.scope.workspaceId === identity.remoteWorkspaceId &&
    status.scope.projectId === identity.remoteProjectId &&
    status.scope.canvasId === identity.remoteCanvasId
  );
}

function hasExactRuntimeIdentity(
  graph: DesktopGraphViewModel,
  status: CanvasRuntimeStatusProjection
): boolean {
  const taskIds = graph.tasks.map((task) => task.taskId);
  const blockRefs = graph.tasks.flatMap((task) => task.blocks.map((block) => block.ref));
  const statusTaskIds = new Set(status.tasks.map((task) => task.taskId));
  const statusBlockRefs = new Set(status.blocks.map((block) => block.ref));
  return (
    taskIds.length === status.tasks.length &&
    blockRefs.length === status.blocks.length &&
    taskIds.every((taskId) => statusTaskIds.has(taskId)) &&
    blockRefs.every((ref) => statusBlockRefs.has(ref))
  );
}

function failClosedDispatchability(graph: DesktopGraphViewModel): DesktopGraphViewModel {
  return {
    ...graph,
    tasks: graph.tasks.map((task) => ({
      ...task,
      blocks: task.blocks.map((block) => ({ ...block, dispatchable: false })),
      blockPreview: task.blockPreview.map((block) => ({ ...block, dispatchable: false }))
    }))
  };
}

export function mergeCollaborationRuntimeStatus(
  graph: DesktopGraphViewModel,
  status: CanvasRuntimeStatusProjection | null,
  expectedScope: CanvasRuntimeStatusProjection["scope"] | null
): DesktopGraphViewModel {
  if (
    !status ||
    !expectedScope ||
    !sameRuntimeScope(status.scope, expectedScope) ||
    !hasExactRuntimeIdentity(graph, status)
  ) {
    return failClosedDispatchability(graph);
  }
  const contentMatchesRuntime = status.packageFingerprint === graph.packageFingerprint;
  const taskStatuses = new Map(status.tasks.map((task) => [task.taskId, task]));
  const blockStatuses = new Map(status.blocks.map((block) => [block.ref, block]));
  return {
    ...graph,
    tasks: graph.tasks.map((task) => {
      const remoteTask = taskStatuses.get(task.taskId);
      if (!remoteTask) throw new Error(`collaboration_runtime_task_status_missing:${task.taskId}`);
      const mergeBlocks = (blocks: typeof task.blocks) =>
        blocks.map((block) => {
          const remoteBlock = blockStatuses.get(block.ref);
          if (!remoteBlock) {
            throw new Error(`collaboration_runtime_block_status_missing:${block.ref}`);
          }
          return {
            ...block,
            status: remoteBlock.status,
            exceptionReason: remoteBlock.blockedReason ?? remoteBlock.divergenceReason ?? null,
            dispatchable: contentMatchesRuntime && remoteBlock.dispatchable
          };
        });
      const blocks = mergeBlocks(task.blocks);
      return {
        ...task,
        status: remoteTask.status,
        blocks,
        blockPreview: mergeBlocks(task.blockPreview),
        exceptions: blocks.flatMap((block) => {
          if (!block.exceptionReason || (block.status !== "blocked" && block.status !== "diverged")) {
            return [];
          }
          return [{ ref: block.ref, reason: block.exceptionReason, source: block.status }];
        })
      };
    })
  };
}

export function useCollaborationRuntimeStatus(input: {
  enabled: boolean;
  sessionConnected: boolean;
  profileId: string | null;
  activeProjectId: string | null;
  localProjectId: string | null;
  localCanvasId: string | null;
  graph: DesktopGraphViewModel | null;
  api?: CollaborationRuntimeStatusBridge | null;
}): { graph: DesktopGraphViewModel | null; error: string | null } {
  const api = input.api === undefined ? collaborationBridge : input.api;
  const [snapshot, setSnapshot] = useState<RuntimeStatusSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (
      !api ||
      !input.enabled ||
      !input.sessionConnected ||
      !input.profileId ||
      !input.activeProjectId ||
      !input.localProjectId ||
      !input.localCanvasId ||
      !input.graph
    ) {
      setSnapshot(null);
      setError(null);
      return undefined;
    }
    const profileId = input.profileId;
    const activeProjectId = input.activeProjectId;
    const localProjectId = input.localProjectId;
    const localCanvasId = input.localCanvasId;
    let active = true;
    let inFlight = false;
    let identity: ResolvedCanvasIdentity | null = null;
    setError(null);

    const refresh = async () => {
      if (!active || inFlight || !identity) return;
      const currentIdentity = identity;
      inFlight = true;
      try {
        const next = await api.readCollaborationCanvasRuntimeStatus({
          localProjectId,
          canvasId: localCanvasId
        });
        if (!active) return;
        if (
          !next ||
          !matchesResolvedCanvas(next, currentIdentity)
        ) {
          setSnapshot(null);
          return;
        }
        setSnapshot({ identity: currentIdentity, status: next });
        setError(null);
      } catch (caught) {
        if (active) {
          setSnapshot(null);
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      } finally {
        inFlight = false;
      }
    };

    void api
      .resolveCollaborationCanvasScope({ localProjectId, canvasId: localCanvasId })
      .then((resolved) => {
        if (!active || !resolved || resolved.projectId !== activeProjectId) return;
        const resolvedIdentity: ResolvedCanvasIdentity = {
          profileId,
          localProjectId,
          localCanvasId,
          remoteWorkspaceId: resolved.workspaceId,
          remoteProjectId: resolved.projectId,
          remoteCanvasId: resolved.canvasId
        };
        identity = resolvedIdentity;
        void refresh();
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      });
    const intervalId = setInterval(() => void refresh(), COLLABORATION_RUNTIME_STATUS_POLL_MS);
    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, [
    api,
    input.activeProjectId,
    input.enabled,
    input.graph?.packageFingerprint,
    input.localCanvasId,
    input.localProjectId,
    input.profileId,
    input.sessionConnected
  ]);

  const currentSnapshot =
    snapshot &&
    input.profileId &&
    input.localProjectId &&
    input.localCanvasId &&
    input.activeProjectId &&
    snapshot.identity.profileId === input.profileId &&
    snapshot.identity.localProjectId === input.localProjectId &&
    snapshot.identity.localCanvasId === input.localCanvasId &&
    snapshot.identity.remoteProjectId === input.activeProjectId
      ? snapshot
      : null;

  return useMemo(
    () => ({
      graph: input.graph
        ? mergeCollaborationRuntimeStatus(
            input.graph,
            currentSnapshot?.status ?? null,
            currentSnapshot
              ? {
                  workspaceId: currentSnapshot.identity.remoteWorkspaceId,
                  projectId: currentSnapshot.identity.remoteProjectId,
                  canvasId: currentSnapshot.identity.remoteCanvasId
                }
              : null
          )
        : null,
      error
    }),
    [currentSnapshot, error, input.graph]
  );
}
