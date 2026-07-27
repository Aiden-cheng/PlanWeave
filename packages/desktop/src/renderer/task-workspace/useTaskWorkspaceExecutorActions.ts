import { useCallback } from "react";
import type { DesktopBridgeApi } from "@planweave-ai/runtime";
import { runDurablePackageWrite } from "../collaboration/packageWriteAdapter";
import type { SharedCanvasCommandsResult } from "../hooks/useSharedCanvasCommands";
import type { TaskWorkspaceNavigationIdentity } from "../taskWorkspaceNavigation";
import type { TaskWorkspaceController } from "./contracts";

type TaskWorkspaceExecutorApi = Pick<
  DesktopBridgeApi,
  "getBlockDetail" | "getTaskDetail" | "updateBlockExecutor" | "updateTaskExecutor"
>;

function graphEditError(
  result: Awaited<ReturnType<DesktopBridgeApi["updateTaskExecutor"]>>
): string {
  return (
    result.diagnostics.map((diagnostic) => diagnostic.message).join("\n") ||
    "The executor could not be saved."
  );
}

export function useTaskWorkspaceExecutorActions(options: {
  api: TaskWorkspaceExecutorApi | null | undefined;
  navigation: TaskWorkspaceNavigationIdentity | null;
  onSaved: () => void;
  sharedCanvas?: SharedCanvasCommandsResult | null;
}): Pick<TaskWorkspaceController, "saveBlockExecutor" | "saveTaskExecutor"> {
  const { api, navigation, onSaved, sharedCanvas = null } = options;

  const saveTaskExecutor = useCallback<TaskWorkspaceController["saveTaskExecutor"]>(
    async (executorName) => {
      if (!api || !navigation) {
        throw new Error(
          "Cannot save a Task executor without a Task Workspace bridge and identity."
        );
      }
      const canvasRef = {
        projectRoot: navigation.projectRoot,
        canvasId: navigation.canvasId
      };
      const current = await api.getTaskDetail(canvasRef, navigation.taskId);
      if (current.taskId !== navigation.taskId) {
        throw new Error("The loaded Task does not match this Task Workspace.");
      }
      let sharedError: string | null = null;
      const mode = await runDurablePackageWrite({
        sharedCanvas,
        intent: {
          kind: "update_task_fields",
          taskId: navigation.taskId,
          fields: { executor: executorName }
        },
        onError: (message) => {
          sharedError = message;
        },
        localWrite: async () => {
          const result = await api.updateTaskExecutor(canvasRef, navigation.taskId, executorName);
          if (!result.ok) {
            throw new Error(graphEditError(result));
          }
        }
      });
      if (mode === "failed") {
        throw new Error(sharedError ?? "Shared canvas command failed.");
      }
      onSaved();
    },
    [api, navigation, onSaved, sharedCanvas]
  );

  const saveBlockExecutor = useCallback<TaskWorkspaceController["saveBlockExecutor"]>(
    async (blockRef, executorName) => {
      if (!api || !navigation) {
        throw new Error(
          "Cannot save a Block executor without a Task Workspace bridge and identity."
        );
      }
      const canvasRef = {
        projectRoot: navigation.projectRoot,
        canvasId: navigation.canvasId
      };
      const current = await api.getBlockDetail(canvasRef, blockRef);
      if (current.ref !== blockRef || current.taskId !== navigation.taskId) {
        throw new Error("The loaded Block does not belong to this Task Workspace.");
      }
      let sharedError: string | null = null;
      const mode = await runDurablePackageWrite({
        sharedCanvas,
        intent: {
          kind: "update_block_fields",
          blockRef,
          fields: { executor: executorName }
        },
        onError: (message) => {
          sharedError = message;
        },
        localWrite: async () => {
          const result = await api.updateBlockExecutor(canvasRef, blockRef, executorName);
          if (!result.ok) {
            throw new Error(graphEditError(result));
          }
        }
      });
      if (mode === "failed") {
        throw new Error(sharedError ?? "Shared canvas command failed.");
      }
      onSaved();
    },
    [api, navigation, onSaved, sharedCanvas]
  );

  return { saveBlockExecutor, saveTaskExecutor };
}
