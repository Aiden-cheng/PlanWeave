import { useCallback } from "react";
import type { DesktopProjectSummary } from "@planweave-ai/runtime";
import { bridge, desktopCanvasReference } from "../bridge";
import { runDurablePackageWrite } from "../collaboration/packageWriteAdapter";
import type { SharedCanvasCommandsResult } from "./useSharedCanvasCommands";

type UseTaskExecutorActionsArgs = {
  refreshGraph: () => Promise<void>;
  selectedCanvasId: string | null;
  selectedProject: DesktopProjectSummary | null;
  setError: (message: string | null) => void;
  /** When enabled, task executor writes go through shared canvas commands. */
  sharedCanvas?: SharedCanvasCommandsResult | null;
};

export function useTaskExecutorActions({
  refreshGraph,
  selectedCanvasId,
  selectedProject,
  setError,
  sharedCanvas = null
}: UseTaskExecutorActionsArgs) {
  const handleTaskExecutorChange = useCallback(
    async (taskId: string, executorName: string | null) => {
      if (!selectedProject) {
        return;
      }
      try {
        const mode = await runDurablePackageWrite({
          sharedCanvas,
          intent: {
            kind: "update_task_fields",
            taskId,
            fields: { executor: executorName }
          },
          onError: setError,
          localWrite: async () => {
            if (!bridge) return;
            const result = await bridge.updateTaskExecutor(
              desktopCanvasReference(selectedProject, selectedCanvasId),
              taskId,
              executorName
            );
            if (!result.ok) {
              throw new Error(
                result.diagnostics.map((diagnostic) => diagnostic.message).join("\n")
              );
            }
          }
        });
        if (mode === "failed") return;
        await refreshGraph();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [refreshGraph, selectedCanvasId, selectedProject, setError, sharedCanvas]
  );

  return { handleTaskExecutorChange };
}
