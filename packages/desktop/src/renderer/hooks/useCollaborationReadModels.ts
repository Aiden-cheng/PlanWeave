import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { collaborationBridge } from "../bridge";
import {
  CollaborationReadModelController,
  type CollaborationReadBridgePort
} from "../collaboration/CollaborationReadModelController";
import {
  buildCollaborationProjectViewModel,
  type CollaborationProjectViewModel,
  type LocalRuntimeWorkItemFacts
} from "../collaboration/collaborationViewModels";
import type { CollaborationReadModelSnapshot } from "../../shared/collaborationReadModels.js";

export type UseCollaborationReadModelsArgs = {
  profileId: string | null;
  projectId: string | null;
  canvasId?: string | null;
  /** Optional local Runtime facts merged only in view-model functions. */
  localWorkItems?: readonly LocalRuntimeWorkItemFacts[];
  /** Injected bridge for tests; defaults to window.planweaveCollaboration. */
  api?: CollaborationReadBridgePort | null;
};

export type UseCollaborationReadModelsResult = {
  snapshot: CollaborationReadModelSnapshot;
  viewModel: CollaborationProjectViewModel;
  controller: CollaborationReadModelController | null;
};

/**
 * Single shared collaboration read-model subscription for the active project.
 * Components must not open additional observer connections.
 */
export function useCollaborationReadModels(
  args: UseCollaborationReadModelsArgs
): UseCollaborationReadModelsResult {
  const api =
    args.api === undefined
      ? (collaborationBridge as CollaborationReadBridgePort | null)
      : args.api;

  const controllerRef = useRef<CollaborationReadModelController | null>(null);
  const [controllerVersion, setControllerVersion] = useState(0);

  useEffect(() => {
    if (!api) {
      controllerRef.current?.dispose();
      controllerRef.current = null;
      setControllerVersion((value) => value + 1);
      return;
    }

    const controller = new CollaborationReadModelController({ api });
    controllerRef.current = controller;
    setControllerVersion((value) => value + 1);

    return () => {
      controller.dispose();
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    };
  }, [api]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    if (!args.profileId || !args.projectId) {
      controller.clear();
      return;
    }
    void controller.setActiveProject({
      profileId: args.profileId,
      projectId: args.projectId,
      canvasId: args.canvasId
    });
  }, [args.profileId, args.projectId, args.canvasId, controllerVersion]);

  const controller = controllerRef.current;
  const snapshot = useSyncExternalStore(
    (onStoreChange) => {
      if (!controller) return () => undefined;
      return controller.subscribe(onStoreChange);
    },
    () => controller?.getSnapshot() ?? idleSnapshot(),
    () => idleSnapshot()
  );

  const viewModel = useMemo(
    () =>
      buildCollaborationProjectViewModel({
        snapshot,
        localWorkItems: args.localWorkItems
      }),
    [snapshot, args.localWorkItems]
  );

  return { snapshot, viewModel, controller };
}

const IDLE_SNAPSHOT: CollaborationReadModelSnapshot = {
  profileId: null,
  projectId: null,
  canvasId: null,
  syncPhase: "idle",
  observerCursor: 0,
  members: [],
  hosts: [],
  assignmentsByWorkItem: {},
  commentsByWorkItem: {},
  activity: [],
  remoteRunsByDispatchId: {},
  mutationsById: {},
  lastError: null,
  loadingKinds: [],
  updatedAt: new Date(0).toISOString()
};

function idleSnapshot(): CollaborationReadModelSnapshot {
  return IDLE_SNAPSHOT;
}
