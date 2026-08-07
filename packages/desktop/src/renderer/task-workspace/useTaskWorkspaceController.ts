import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  composeTaskWorkspaceRuns,
  projectTaskWorkspaceLiveSnapshot
} from "@planweave-ai/runtime/browser";
import type {
  DesktopBridgeApi,
  DesktopRunRecord,
  TaskWorkspace,
  TaskWorkspaceRunListItem,
  TaskWorkspaceRunsCursor
} from "@planweave-ai/runtime";
import type { DesktopAgentEndpointPreference } from "../../shared/desktopSettings";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration";
import { bridge, collaborationBridge } from "../bridge";
import {
  agentEndpointPreferenceKey,
  selectedAgentEndpointId
} from "../collaboration/agentEndpointPreferences";
import {
  applyAgentEndpointRequirements,
  type AvailableAgentEndpoint
} from "../collaboration/agentEndpointViewModel";
import { runDurablePackageWrite } from "../collaboration/packageWriteAdapter";
import type { AppViewHistoryController } from "../hooks/useAppViewHistory";
import type { SharedCanvasCommandsResult } from "../hooks/useSharedCanvasCommands";
import { useRunnerRecordMonitor } from "../hooks/useRunnerRecordMonitor";
import {
  taskWorkspaceNavigationTargetSchema,
  type TaskWorkspaceNavigationIdentity
} from "../taskWorkspaceNavigation";
import type {
  TaskWorkspaceController,
  TaskWorkspaceLiveStatus,
  TaskWorkspaceSelectedRun
} from "./contracts";
import {
  projectSharedTaskWorkspace,
  sharedBlockPromptMarkdown,
  sharedTaskPromptMarkdown
} from "./taskWorkspaceSharedProjection";
import { useTaskWorkspaceExecutorActions } from "./useTaskWorkspaceExecutorActions";
import { useRemoteTaskWorkspaceConversation } from "./useRemoteTaskWorkspaceConversation";
import {
  agentFamilyFromExecutorName,
  diskSelectedRecordId,
  isRemoteLiveRecordId,
  remoteLiveRecordId,
  withRemoteLiveTimelineRuns,
  type RemoteLiveAgentHint
} from "./remoteLiveRun";

type TaskWorkspaceApi = Pick<
  DesktopBridgeApi,
  | "getBlockDetail"
  | "getGraphViewModel"
  | "getTaskDetail"
  | "getTaskWorkspace"
  | "getTaskWorkspaceRunDetail"
  | "listTaskWorkspaceRuns"
  | "onAutoRunChanged"
  | "onRuntimeStateChanged"
  | "subscribeRunnerRecord"
  | "updateBlockExecutor"
  | "updateBlockPrompt"
  | "updateTaskExecutor"
  | "updateTaskPrompt"
>;

type WorkspaceLoad = {
  error: string | null;
  key: string;
  packageExecutorNames: string[];
  requiredCapabilitiesByBlockRef: Record<string, string[]>;
  taskRequiredCapabilities: string[];
  status: "idle" | "loading" | "ready" | "error";
  workspace: TaskWorkspace | null;
};

type RecordLoad = {
  blockRef: string | null;
  error: string | null;
  item: TaskWorkspaceSelectedRun["item"] | null;
  key: string;
  record: DesktopRunRecord | null;
  status: "idle" | "loading" | "ready" | "error";
};

const idleWorkspaceLoad: WorkspaceLoad = {
  error: null,
  key: "",
  packageExecutorNames: [],
  requiredCapabilitiesByBlockRef: {},
  taskRequiredCapabilities: [],
  status: "idle",
  workspace: null
};
const idleRecordLoad: RecordLoad = {
  blockRef: null,
  error: null,
  item: null,
  key: "",
  record: null,
  status: "idle"
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function graphEditError(result: Awaited<ReturnType<DesktopBridgeApi["updateTaskPrompt"]>>): string {
  return (
    result.diagnostics.map((diagnostic) => diagnostic.message).join("\n") ||
    "The graph edit could not be saved."
  );
}

function taskWorkspaceAuthorityKey(navigation: TaskWorkspaceNavigationIdentity): string {
  return JSON.stringify([navigation.projectRoot, navigation.canvasId, navigation.taskId]);
}

function taskWorkspaceRecordKey(authorityKey: string, recordId: string): string {
  return `${authorityKey}\u0000${recordId}`;
}

function findRun(
  workspace: TaskWorkspace,
  blockRef: string,
  recordId: string
): TaskWorkspaceSelectedRun | null {
  const block = workspace.blocks.find((candidate) => candidate.ref === blockRef);
  const item = block?.runs.find((candidate) => candidate.run.record.recordId === recordId);
  return block && item ? { block, item } : null;
}

function initialRunForNavigation(
  workspace: TaskWorkspace,
  navigation: TaskWorkspaceNavigationIdentity
): TaskWorkspaceSelectedRun | null {
  if (navigation.recordId && navigation.blockRef) {
    return findRun(workspace, navigation.blockRef, navigation.recordId);
  }
  if (navigation.blockRef) {
    const block = workspace.blocks.find((candidate) => candidate.ref === navigation.blockRef);
    // Prefer live remote attempt over the previous completed local run.
    const item =
      block?.runs.find(
        (candidate) => candidate.active && isRemoteLiveRecordId(candidate.run.record.recordId)
      ) ??
      block?.runs.find((candidate) => candidate.active) ??
      block?.runs.at(-1);
    return block && item ? { block, item } : null;
  }
  // Task-level open: still prefer any in-flight remote live row.
  for (const block of workspace.blocks) {
    const live = block.runs.find(
      (candidate) => candidate.active && isRemoteLiveRecordId(candidate.run.record.recordId)
    );
    if (live) return { block, item: live };
  }
  return null;
}

function preferredRemoteLiveSelection(
  workspace: TaskWorkspace,
  preferredBlockRef: string | null | undefined
): { blockRef: string; recordId: string } | null {
  const ordered = preferredBlockRef
    ? [
        ...workspace.blocks.filter((block) => block.ref === preferredBlockRef),
        ...workspace.blocks.filter((block) => block.ref !== preferredBlockRef)
      ]
    : workspace.blocks;
  for (const block of ordered) {
    const remote = block.remoteExecution;
    if (!remote || remote.phase === "terminal") continue;
    return {
      blockRef: block.ref,
      recordId: remoteLiveRecordId(block.ref, remote.identity.operationId)
    };
  }
  return null;
}

export function useTaskWorkspaceController(options: {
  agentEndpointCatalog: readonly AvailableAgentEndpoint[];
  agentEndpointPreferences: Record<string, DesktopAgentEndpointPreference>;
  api?: TaskWorkspaceApi | null;
  collaborationApi?: Pick<
    PlanWeaveCollaborationApi,
    | "observeCollaborationRemoteOperation"
    | "onCollaborationObserverSignal"
    | "replayCollaborationRemoteOperationEvents"
  > | null;
  history: AppViewHistoryController;
  saveAgentEndpointPreference: (
    key: string,
    endpoint: AvailableAgentEndpoint | null
  ) => Promise<void>;
  /** When enabled, task/block prompt and executor writes use shared canvas commands. */
  sharedCanvas?: SharedCanvasCommandsResult | null;
}): TaskWorkspaceController {
  const {
    agentEndpointCatalog,
    agentEndpointPreferences,
    api = bridge,
    collaborationApi = collaborationBridge,
    history,
    saveAgentEndpointPreference,
    sharedCanvas = null
  } = options;
  const navigation = history.taskWorkspaceNavigation;
  const [refreshVersion, setRefreshVersion] = useState(0);
  const refresh = useCallback(() => setRefreshVersion((current) => current + 1), []);
  const [workspaceLoad, setWorkspaceLoad] = useState<WorkspaceLoad>(idleWorkspaceLoad);
  const [recordLoad, setRecordLoad] = useState<RecordLoad>(idleRecordLoad);
  const [overviewSelected, setOverviewSelected] = useState(false);
  const [selectedAnnotationIdentity, setSelectedAnnotationIdentity] = useState<{
    annotationId: string;
    blockRef: string;
  } | null>(null);
  const [hasMoreRuns, setHasMoreRuns] = useState(false);
  const [loadingMoreRuns, setLoadingMoreRuns] = useState(false);
  const [loadMoreRunsError, setLoadMoreRunsError] = useState<string | null>(null);
  const workspaceRequest = useRef(0);
  const recordRequest = useRef(0);
  const recordLoads = useRef(new Map<string, RecordLoad>());
  const overviewSelectedRef = useRef(false);
  const runScrollPositions = useRef(new Map<string, number>());
  const runItemsRef = useRef<TaskWorkspaceRunListItem[]>([]);
  const nextCursorRef = useRef<TaskWorkspaceRunsCursor | null>(null);
  const loadingMoreRef = useRef(false);
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  const key = navigation ? taskWorkspaceAuthorityKey(navigation) : "";
  const navigationProjectRoot = navigation?.projectRoot ?? null;
  const navigationCanvasId = navigation?.canvasId ?? null;
  const navigationTaskId = navigation?.taskId ?? null;

  useEffect(() => {
    void key;
    overviewSelectedRef.current = false;
    setOverviewSelected(false);
    setSelectedAnnotationIdentity(null);
  }, [key]);

  useEffect(() => {
    void navigation?.blockRef;
    void navigation?.recordId;
    overviewSelectedRef.current = false;
    setOverviewSelected(false);
    setSelectedAnnotationIdentity(null);
  }, [navigation?.blockRef, navigation?.recordId]);

  useEffect(() => {
    void refreshVersion;
    const request = ++workspaceRequest.current;
    const requestedNavigation = navigationRef.current;
    if (!requestedNavigation) {
      return;
    }
    if (!api) {
      setWorkspaceLoad({
        error: "Task Workspace bridge is unavailable.",
        key,
        packageExecutorNames: [],
        requiredCapabilitiesByBlockRef: {},
        taskRequiredCapabilities: [],
        status: "error",
        workspace: null
      });
      return;
    }
    setWorkspaceLoad((current) => {
      if (current.key === key && current.workspace) {
        return { ...current, error: null };
      }
      return {
        error: null,
        key,
        packageExecutorNames: [],
        requiredCapabilitiesByBlockRef: {},
        taskRequiredCapabilities: [],
        status: "loading",
        workspace: null
      };
    });
    const canvasRef = {
      projectRoot: requestedNavigation.projectRoot,
      canvasId: requestedNavigation.canvasId
    };
    void Promise.all([
      api.getTaskWorkspace({
        ...canvasRef,
        taskId: requestedNavigation.taskId,
        // Synthetic remote-live ids are not on disk — never ask Runtime to resolve them.
        selectedRecordId: diskSelectedRecordId(requestedNavigation.recordId)
      }),
      api.listTaskWorkspaceRuns({
        ...canvasRef,
        taskId: requestedNavigation.taskId
      }),
      api.getGraphViewModel(canvasRef)
    ])
      .then(([header, runsPage, graph]) => {
        if (workspaceRequest.current !== request) {
          return;
        }
        const currentNavigation = navigationRef.current;
        if (!currentNavigation || taskWorkspaceAuthorityKey(currentNavigation) !== key) {
          return;
        }
        const graphTask = graph.tasks.find((task) => task.taskId === currentNavigation.taskId);
        if (!graphTask) {
          setWorkspaceLoad({
            error: `Task '${currentNavigation.taskId}' is unavailable in the current graph view.`,
            key,
            packageExecutorNames: [],
            requiredCapabilitiesByBlockRef: {},
            taskRequiredCapabilities: [],
            status: "error",
            workspace: null
          });
          return;
        }
        if (
          currentNavigation.blockRef &&
          !header.blocks.some((block) => block.ref === currentNavigation.blockRef)
        ) {
          setWorkspaceLoad({
            error: `Block '${currentNavigation.blockRef}' is unavailable for task '${currentNavigation.taskId}'.`,
            key,
            packageExecutorNames: [],
            requiredCapabilitiesByBlockRef: {},
            taskRequiredCapabilities: [],
            status: "error",
            workspace: null
          });
          return;
        }
        const selectedHint = diskSelectedRecordId(currentNavigation.recordId) ?? header.selectedRecordId;
        const pageItems: TaskWorkspaceRunListItem[] = runsPage.items.map((item) => ({
          ...item,
          selected: selectedHint !== null && item.run.record.recordId === selectedHint
        }));
        const composed = composeTaskWorkspaceRuns(header, pageItems);
        const agentHints = new Map<string, RemoteLiveAgentHint>();
        for (const block of composed.blocks) {
          const graphBlock = graphTask.blocks.find((candidate) => candidate.ref === block.ref);
          const executorName =
            block.executor ??
            graphBlock?.executor ??
            composed.task.executor ??
            graphTask.executorLabel ??
            null;
          agentHints.set(block.ref, {
            executorName,
            agentId: agentFamilyFromExecutorName(executorName)
          });
        }
        const workspace = withRemoteLiveTimelineRuns(composed, agentHints);
        runItemsRef.current = pageItems;
        nextCursorRef.current = runsPage.nextCursor;
        setHasMoreRuns(runsPage.nextCursor !== null);
        setLoadMoreRunsError(null);
        setLoadingMoreRuns(false);
        loadingMoreRef.current = false;
        const selected = initialRunForNavigation(workspace, currentNavigation);
        const liveSelection = preferredRemoteLiveSelection(
          workspace,
          currentNavigation.blockRef
        );
        // Prefer the live remote attempt over a stale historical record while remote is active.
        if (
          liveSelection &&
          !overviewSelectedRef.current &&
          currentNavigation.recordId !== liveSelection.recordId
        ) {
          history.replaceTaskWorkspaceTarget(
            taskWorkspaceNavigationTargetSchema.parse({
              projectRoot: currentNavigation.projectRoot,
              canvasId: currentNavigation.canvasId,
              taskId: currentNavigation.taskId,
              blockRef: liveSelection.blockRef,
              recordId: liveSelection.recordId
            })
          );
        } else if (
          isRemoteLiveRecordId(currentNavigation.recordId) &&
          !liveSelection &&
          !overviewSelectedRef.current
        ) {
          // Remote finished: leave the synthetic id so reload does not hit disk index.
          const blockRef = currentNavigation.blockRef;
          const block = blockRef
            ? workspace.blocks.find((candidate) => candidate.ref === blockRef)
            : null;
          const latestReal = block?.runs
            .filter((item) => !isRemoteLiveRecordId(item.run.record.recordId))
            .at(-1);
          history.replaceTaskWorkspaceTarget(
            taskWorkspaceNavigationTargetSchema.parse({
              projectRoot: currentNavigation.projectRoot,
              canvasId: currentNavigation.canvasId,
              taskId: currentNavigation.taskId,
              blockRef: latestReal?.run.record.ref ?? blockRef ?? undefined,
              recordId: latestReal?.run.record.recordId ?? undefined
            })
          );
        } else if (!currentNavigation.recordId && selected && !overviewSelectedRef.current) {
          // Missing selection on the first page is OK when navigating to an older record;
          // getTaskWorkspaceRunDetail validates ownership when the record is selected.
          history.replaceTaskWorkspaceTarget(
            taskWorkspaceNavigationTargetSchema.parse({
              projectRoot: currentNavigation.projectRoot,
              canvasId: currentNavigation.canvasId,
              taskId: currentNavigation.taskId,
              blockRef: selected.block.ref,
              recordId: selected.item.run.record.recordId
            })
          );
        }
        const requiredCapabilitiesByBlockRef = Object.fromEntries(
          graphTask.blocks.map((block) => [block.ref, [...block.requiredCapabilities]])
        );
        const taskRequiredCapabilities = [
          ...new Set(
            graphTask.blocks
              .filter((block) => block.executor === null)
              .flatMap((block) => block.requiredCapabilities)
          )
        ];
        setWorkspaceLoad({
          error: null,
          key,
          packageExecutorNames: graph.packageExecutorNames ?? [],
          requiredCapabilitiesByBlockRef,
          taskRequiredCapabilities,
          status: "ready",
          workspace
        });
      })
      .catch((error: unknown) => {
        if (workspaceRequest.current !== request) {
          return;
        }
        setWorkspaceLoad({
          error: errorMessage(error),
          key,
          packageExecutorNames: [],
          requiredCapabilitiesByBlockRef: {},
          taskRequiredCapabilities: [],
          status: "error",
          workspace: null
        });
      });
  }, [api, history.replaceTaskWorkspaceTarget, key, refreshVersion]);

  const loadedWorkspace = workspaceLoad.key === key ? workspaceLoad.workspace : null;
  const workspace = useMemo(
    () =>
      loadedWorkspace
        ? projectSharedTaskWorkspace(loadedWorkspace, sharedCanvas?.projection ?? null)
        : null,
    [loadedWorkspace, sharedCanvas?.projection]
  );
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const packageExecutorNames = workspaceLoad.key === key ? workspaceLoad.packageExecutorNames : [];
  const routedSelectedRun = useMemo(() => {
    if (!workspace || !navigation?.blockRef || !navigation.recordId) {
      return null;
    }
    return findRun(workspace, navigation.blockRef, navigation.recordId);
  }, [navigation?.blockRef, navigation?.recordId, workspace]);
  const visibleRecordLoad = navigation?.recordId
    ? recordLoad.key === navigation.recordId
      ? recordLoad
      : (recordLoads.current.get(taskWorkspaceRecordKey(key, navigation.recordId)) ??
        idleRecordLoad)
    : idleRecordLoad;
  const detailSelectedRun = useMemo(() => {
    if (
      !workspace ||
      visibleRecordLoad.key !== navigation?.recordId ||
      !visibleRecordLoad.blockRef ||
      !visibleRecordLoad.item
    ) {
      return null;
    }
    const block = workspace.blocks.find(
      (candidate) => candidate.ref === visibleRecordLoad.blockRef
    );
    return block ? { block, item: visibleRecordLoad.item } : null;
  }, [navigation?.recordId, visibleRecordLoad, workspace]);
  const selectedAnnotation = useMemo(() => {
    if (!workspace || !selectedAnnotationIdentity) return null;
    const block = workspace.blocks.find(
      (candidate) => candidate.ref === selectedAnnotationIdentity.blockRef
    );
    const annotation = block?.annotations.find(
      (candidate) => candidate.annotationId === selectedAnnotationIdentity.annotationId
    );
    return block && annotation ? { annotation, block } : null;
  }, [selectedAnnotationIdentity, workspace]);
  const selectedRun =
    overviewSelected || selectedAnnotation ? null : (routedSelectedRun ?? detailSelectedRun);
  const selectedRecordId =
    overviewSelected || selectedAnnotation
      ? null
      : (navigation?.recordId ?? selectedRun?.item.run.record.recordId ?? null);
  const selectedRecordKey = selectedAnnotation
    ? ""
    : (navigation?.recordId ?? selectedRun?.item.run.record.recordId ?? "");
  const selectedBlockRef =
    selectedAnnotation?.block.ref ?? navigation?.blockRef ?? selectedRun?.block.ref ?? "";
  const selectedRemoteExecution = workspace?.blocks.find(
    (block) => block.ref === selectedBlockRef
  )?.remoteExecution;
  const remoteConversation = useRemoteTaskWorkspaceConversation({
    api: collaborationApi,
    blockRef: selectedBlockRef || null,
    operationId:
      selectedRemoteExecution &&
      (selectedRemoteExecution.phase !== "terminal" || selectedRemoteExecution.status === "failed")
        ? selectedRemoteExecution.identity.operationId
        : null,
    onTerminal: refresh
  });

  useEffect(() => {
    const request = ++recordRequest.current;
    if (
      !api ||
      navigationProjectRoot === null ||
      navigationCanvasId === null ||
      navigationTaskId === null ||
      !selectedRecordKey ||
      overviewSelected
    ) {
      setRecordLoad(idleRecordLoad);
      return;
    }
    // Synthetic remote-live rows are not persisted on disk; project from the live workspace only.
    if (isRemoteLiveRecordId(selectedRecordKey)) {
      const found =
        selectedBlockRef && workspaceRef.current
          ? findRun(workspaceRef.current, selectedBlockRef, selectedRecordKey)
          : null;
      setRecordLoad({
        blockRef: found?.block.ref ?? (selectedBlockRef || null),
        error: found ? null : "Remote live attempt is no longer active.",
        item: found?.item ?? null,
        key: selectedRecordKey,
        record: null,
        status: found ? "ready" : "error"
      });
      return;
    }
    const cacheKey = taskWorkspaceRecordKey(key, selectedRecordKey);
    const cachedLoad = recordLoads.current.get(cacheKey) ?? null;
    setRecordLoad(
      cachedLoad ?? {
        blockRef: null,
        error: null,
        item: null,
        key: selectedRecordKey,
        record: null,
        status: "loading"
      }
    );
    void api
      .getTaskWorkspaceRunDetail({
        projectRoot: navigationProjectRoot,
        canvasId: navigationCanvasId,
        taskId: navigationTaskId,
        recordId: selectedRecordKey
      })
      .then((detail) => {
        if (recordRequest.current !== request) {
          return;
        }
        const record: DesktopRunRecord = detail.record;
        if (
          record.recordId !== selectedRecordKey ||
          record.ref !== (selectedBlockRef || record.ref) ||
          record.taskId !== navigationTaskId ||
          detail.taskId !== navigationTaskId
        ) {
          recordLoads.current.delete(cacheKey);
          setRecordLoad({
            blockRef: null,
            error: "Selected run record does not match its Task Workspace navigation identity.",
            item: null,
            key: selectedRecordKey,
            record: null,
            status: "error"
          });
          return;
        }
        if (detail.item.run.kind === "block") {
          // Block details refine the paged summary. Feedback details remain a selected
          // annotation and must not be inserted into the Block run pagination model.
          const listItem: TaskWorkspaceRunListItem = {
            blockRef: detail.blockRef,
            ...detail.item
          };
          const without = runItemsRef.current.filter(
            (item) => item.run.record.recordId !== listItem.run.record.recordId
          );
          runItemsRef.current = [...without, listItem];
          setWorkspaceLoad((current) => {
            if (!current.workspace || current.key !== key) {
              return current;
            }
            return {
              ...current,
              workspace: withRemoteLiveTimelineRuns(
                composeTaskWorkspaceRuns(current.workspace, runItemsRef.current)
              )
            };
          });
        }
        const loadedRecord: RecordLoad = {
          blockRef: detail.blockRef,
          error: null,
          item: detail.item,
          key: selectedRecordKey,
          record,
          status: "ready"
        };
        recordLoads.current.set(cacheKey, loadedRecord);
        setRecordLoad(loadedRecord);
      })
      .catch((error: unknown) => {
        if (recordRequest.current !== request) {
          return;
        }
        setRecordLoad({
          blockRef: cachedLoad?.blockRef ?? null,
          error: errorMessage(error),
          item: cachedLoad?.item ?? null,
          key: selectedRecordKey,
          record: cachedLoad?.record ?? null,
          status: "error"
        });
      });
  }, [
    api,
    key,
    navigationCanvasId,
    navigationProjectRoot,
    navigationTaskId,
    overviewSelected,
    selectedBlockRef,
    selectedRecordKey,
    // Re-project synthetic remote-live rows when workspace remoteExecution changes.
    workspace?.blocks.map((block) => block.remoteExecution?.identity.operationId).join("|") ?? ""
  ]);

  const selectedRecord =
    visibleRecordLoad.key === selectedRecordKey ? visibleRecordLoad.record : null;
  const initialModel = selectedRecord?.runnerReadModel ?? null;
  const canvasRef = useMemo(
    () =>
      navigationProjectRoot === null || navigationCanvasId === null
        ? null
        : { projectRoot: navigationProjectRoot, canvasId: navigationCanvasId },
    [navigationCanvasId, navigationProjectRoot]
  );
  const monitor = useRunnerRecordMonitor({
    api,
    canvasRef,
    initialModel,
    recordId: selectedRecord?.recordId ?? null
  });

  // Clock ticks must not rebuild the Task Workspace aggregate. Live duration/relative
  // labels subscribe via useTaskWorkspaceClock in leaf components only.
  // Live runner model merges still re-project when monitor.model changes (data, not clock).
  const liveProjection = useMemo(() => {
    if (!workspace) {
      return {
        error: null as string | null,
        runnerModel: null,
        selectedRun: null,
        workspace: null
      };
    }
    // Prefer the live monitor model; fall back to the disk snapshot so completed ACP
    // conversations remain visible when live projection cannot re-match the run list.
    const model = monitor.model ?? selectedRecord?.runnerReadModel ?? null;
    if (!selectedRun || !model) {
      return {
        error: null as string | null,
        runnerModel: null,
        selectedRun,
        workspace
      };
    }
    if (selectedRun.item.run.kind === "feedback") {
      return {
        error: null,
        runnerModel: model,
        selectedRun,
        workspace
      };
    }
    try {
      const projectedWorkspace = projectTaskWorkspaceLiveSnapshot({
        workspace,
        recordId: selectedRun.item.run.record.recordId,
        model,
        now: new Date()
      });
      const projectedSelectedRun = findRun(
        projectedWorkspace,
        selectedRun.block.ref,
        selectedRun.item.run.record.recordId
      );
      if (!projectedSelectedRun) {
        throw new Error(
          `Projected Task Workspace record '${selectedRun.item.run.record.recordId}' is unavailable.`
        );
      }
      return {
        error: null,
        runnerModel: model,
        selectedRun: projectedSelectedRun,
        workspace: projectedWorkspace
      };
    } catch {
      // Keep the conversation model even when live list projection fails (common right
      // after a run finishes and before the run list is recomposed).
      return {
        error: null,
        runnerModel: model,
        selectedRun,
        workspace
      };
    }
  }, [monitor.model, selectedRecord?.runnerReadModel, selectedRun, workspace]);

  useEffect(() => {
    if (!api || !canvasRef) {
      return;
    }
    const matchesCanvas = (event: { projectRoot: string; canvasId: string | null }) =>
      event.projectRoot === canvasRef.projectRoot && event.canvasId === canvasRef.canvasId;
    const refreshFromEvent = () => setRefreshVersion((current) => current + 1);
    const removeRuntimeListener = api.onRuntimeStateChanged((event) => {
      if (matchesCanvas(event)) refreshFromEvent();
    });
    const removeAutoRunListener = api.onAutoRunChanged((event) => {
      if (matchesCanvas(event)) refreshFromEvent();
    });
    return () => {
      removeRuntimeListener();
      removeAutoRunListener();
    };
  }, [api, canvasRef]);

  const selectRun = useCallback<TaskWorkspaceController["selectRun"]>(
    (selection) => {
      if (!navigation) {
        throw new Error("Cannot select a run without a Task Workspace navigation identity.");
      }
      if (selection === null) {
        setSelectedAnnotationIdentity(null);
        overviewSelectedRef.current = true;
        setOverviewSelected(true);
        return;
      }
      overviewSelectedRef.current = false;
      setOverviewSelected(false);
      setSelectedAnnotationIdentity(null);
      history.replaceTaskWorkspaceTarget(
        taskWorkspaceNavigationTargetSchema.parse({
          projectRoot: navigation.projectRoot,
          canvasId: navigation.canvasId,
          taskId: navigation.taskId,
          blockRef: selection.blockRef,
          recordId: selection.recordId
        })
      );
    },
    [history.replaceTaskWorkspaceTarget, navigation]
  );

  const selectAnnotation = useCallback<TaskWorkspaceController["selectAnnotation"]>((selection) => {
    overviewSelectedRef.current = false;
    setOverviewSelected(false);
    setSelectedAnnotationIdentity(selection);
  }, []);

  const loadMoreRuns = useCallback(async () => {
    if (!api || !navigation || !nextCursorRef.current || loadingMoreRef.current) {
      return;
    }
    const cursor = nextCursorRef.current;
    const request = workspaceRequest.current;
    loadingMoreRef.current = true;
    setLoadingMoreRuns(true);
    setLoadMoreRunsError(null);
    try {
      const page = await api.listTaskWorkspaceRuns({
        projectRoot: navigation.projectRoot,
        canvasId: navigation.canvasId,
        taskId: navigation.taskId,
        cursor
      });
      if (workspaceRequest.current !== request) {
        return;
      }
      const selectedHint = navigation.recordId ?? null;
      const existingIds = new Set(runItemsRef.current.map((item) => item.run.record.recordId));
      const appended: TaskWorkspaceRunListItem[] = page.items
        .filter((item) => !existingIds.has(item.run.record.recordId))
        .map((item) => ({
          ...item,
          selected: selectedHint !== null && item.run.record.recordId === selectedHint
        }));
      runItemsRef.current = [...runItemsRef.current, ...appended];
      nextCursorRef.current = page.nextCursor;
      setHasMoreRuns(page.nextCursor !== null);
      setWorkspaceLoad((current) => {
        if (!current.workspace || current.key !== key) {
          return current;
        }
        return {
          ...current,
          workspace: withRemoteLiveTimelineRuns(
            composeTaskWorkspaceRuns(current.workspace, runItemsRef.current)
          )
        };
      });
    } catch (error: unknown) {
      if (workspaceRequest.current !== request) {
        return;
      }
      setLoadMoreRunsError(errorMessage(error));
    } finally {
      if (workspaceRequest.current === request) {
        loadingMoreRef.current = false;
        setLoadingMoreRuns(false);
      }
    }
  }, [api, key, navigation]);

  const saveTaskPrompt = useCallback<TaskWorkspaceController["saveTaskPrompt"]>(
    async ({ baseMarkdown, markdown }) => {
      if (!api || !navigation || !workspace) {
        throw new Error("Cannot save a Task prompt without a Task Workspace bridge and identity.");
      }
      const canvasRef = {
        projectRoot: navigation.projectRoot,
        canvasId: navigation.canvasId
      };
      const sharedPrompt = sharedCanvas?.enabled
        ? sharedTaskPromptMarkdown(sharedCanvas.projection, workspace, navigation.taskId)
        : null;
      const current = sharedCanvas?.enabled
        ? null
        : await api.getTaskDetail(canvasRef, navigation.taskId);
      if (sharedCanvas?.enabled && sharedPrompt === null) {
        throw new Error("The shared Task prompt authority is unavailable.");
      }
      if (current && current.taskId !== navigation.taskId) {
        throw new Error("The loaded Task prompt does not match this Task Workspace.");
      }
      if ((sharedPrompt ?? current?.promptMarkdown) !== baseMarkdown) {
        throw new Error(
          "The Task prompt changed outside this editor. Reload the page and merge your changes before saving."
        );
      }
      if (current && (current.graphVersion === undefined || current.promptHash === undefined)) {
        throw new Error(
          "The Task prompt cannot be saved safely because its revision is unavailable."
        );
      }
      let sharedError: string | null = null;
      const mode = await runDurablePackageWrite({
        sharedCanvas,
        intent: {
          kind: "update_task_prompt",
          taskId: navigation.taskId,
          promptMarkdown: markdown
        },
        onError: (message) => {
          sharedError = message;
        },
        localWrite: async () => {
          if (!current) {
            throw new Error("The local Task prompt revision is unavailable.");
          }
          const result = await api.updateTaskPrompt(canvasRef, navigation.taskId, markdown, {
            baseGraphVersion: current.graphVersion,
            basePromptHash: current.promptHash
          });
          if (!result.ok) {
            throw new Error(graphEditError(result));
          }
        }
      });
      if (mode === "failed") {
        throw new Error(sharedError ?? "Shared canvas command failed.");
      }
      if (mode === "local") {
        refresh();
      }
    },
    [api, navigation, refresh, sharedCanvas, workspace]
  );

  const saveBlockPrompt = useCallback<TaskWorkspaceController["saveBlockPrompt"]>(
    async (blockRef, { baseMarkdown, markdown }) => {
      if (!api || !navigation || !workspace) {
        throw new Error("Cannot save a Block prompt without a Task Workspace bridge and identity.");
      }
      const canvasRef = {
        projectRoot: navigation.projectRoot,
        canvasId: navigation.canvasId
      };
      const sharedPrompt = sharedCanvas?.enabled
        ? sharedBlockPromptMarkdown(sharedCanvas.projection, workspace, blockRef)
        : null;
      const current = sharedCanvas?.enabled ? null : await api.getBlockDetail(canvasRef, blockRef);
      if (sharedCanvas?.enabled && sharedPrompt === null) {
        throw new Error("The shared Block prompt authority is unavailable.");
      }
      if (current && (current.ref !== blockRef || current.taskId !== navigation.taskId)) {
        throw new Error("The loaded Block prompt does not belong to this Task Workspace.");
      }
      if ((sharedPrompt ?? current?.promptMarkdown) !== baseMarkdown) {
        throw new Error(
          "The Block prompt changed outside this editor. Reload the page and merge your changes before saving."
        );
      }
      if (current && (current.graphVersion === undefined || current.promptHash === undefined)) {
        throw new Error(
          "The Block prompt cannot be saved safely because its revision is unavailable."
        );
      }
      let sharedError: string | null = null;
      const mode = await runDurablePackageWrite({
        sharedCanvas,
        intent: {
          kind: "update_block_prompt",
          blockRef,
          promptMarkdown: markdown
        },
        onError: (message) => {
          sharedError = message;
        },
        localWrite: async () => {
          if (!current) {
            throw new Error("The local Block prompt revision is unavailable.");
          }
          const result = await api.updateBlockPrompt(canvasRef, blockRef, markdown, {
            baseGraphVersion: current.graphVersion,
            basePromptHash: current.promptHash
          });
          if (!result.ok) {
            throw new Error(graphEditError(result));
          }
        }
      });
      if (mode === "failed") {
        throw new Error(sharedError ?? "Shared canvas command failed.");
      }
      if (mode === "local") {
        refresh();
      }
    },
    [api, navigation, refresh, sharedCanvas, workspace]
  );

  const { saveBlockExecutor, saveTaskExecutor } = useTaskWorkspaceExecutorActions({
    api,
    navigation,
    onSaved: refresh,
    sharedCanvas
  });

  const agentEndpointsForTask = useMemo(
    () =>
      applyAgentEndpointRequirements(
        agentEndpointCatalog,
        workspaceLoad.key === key ? workspaceLoad.taskRequiredCapabilities : []
      ),
    [agentEndpointCatalog, key, workspaceLoad]
  );
  const agentEndpointsForBlock = useCallback(
    (blockRef: string) =>
      applyAgentEndpointRequirements(
        agentEndpointCatalog,
        workspaceLoad.key === key
          ? (workspaceLoad.requiredCapabilitiesByBlockRef[blockRef] ?? [])
          : []
      ),
    [agentEndpointCatalog, key, workspaceLoad]
  );
  const taskEndpointPreferenceKey = navigation
    ? agentEndpointPreferenceKey({
        projectRoot: navigation.projectRoot,
        canvasId: navigation.canvasId,
        scope: { kind: "task", taskId: navigation.taskId }
      })
    : null;
  const selectedAgentEndpointIdForTask = selectedAgentEndpointId({
    executorName: workspace?.task.executor ?? "manual",
    preference: taskEndpointPreferenceKey
      ? agentEndpointPreferences[taskEndpointPreferenceKey]
      : undefined
  });
  const selectedAgentEndpointIdForBlock = useCallback(
    (blockRef: string): string | null => {
      const block = workspace?.blocks.find((candidate) => candidate.ref === blockRef);
      if (!block || !navigation || !block.executor) return null;
      const preferenceKey = agentEndpointPreferenceKey({
        projectRoot: navigation.projectRoot,
        canvasId: navigation.canvasId,
        scope: { kind: "block", blockRef }
      });
      return selectedAgentEndpointId({
        executorName: block.executor,
        preference: agentEndpointPreferences[preferenceKey]
      });
    },
    [agentEndpointPreferences, navigation, workspace]
  );
  const saveTaskAgentEndpoint = useCallback<TaskWorkspaceController["saveTaskAgentEndpoint"]>(
    async (endpointId) => {
      if (!taskEndpointPreferenceKey) {
        throw new Error("Cannot save an Agent Endpoint without a Task Workspace identity.");
      }
      const endpoint = agentEndpointsForTask.find(
        (candidate) => candidate.id === endpointId && candidate.available
      );
      if (!endpoint) throw new Error("The selected Agent Endpoint is unavailable.");
      await saveTaskExecutor(endpoint.executorName);
      await saveAgentEndpointPreference(taskEndpointPreferenceKey, endpoint);
    },
    [
      agentEndpointsForTask,
      saveAgentEndpointPreference,
      saveTaskExecutor,
      taskEndpointPreferenceKey
    ]
  );
  const saveBlockAgentEndpoint = useCallback<TaskWorkspaceController["saveBlockAgentEndpoint"]>(
    async (blockRef, endpointId) => {
      if (!navigation) {
        throw new Error("Cannot save an Agent Endpoint without a Task Workspace identity.");
      }
      const preferenceKey = agentEndpointPreferenceKey({
        projectRoot: navigation.projectRoot,
        canvasId: navigation.canvasId,
        scope: { kind: "block", blockRef }
      });
      if (endpointId === null) {
        await saveBlockExecutor(blockRef, null);
        await saveAgentEndpointPreference(preferenceKey, null);
        return;
      }
      const endpoint = agentEndpointsForBlock(blockRef).find(
        (candidate) => candidate.id === endpointId && candidate.available
      );
      if (!endpoint) throw new Error("The selected Agent Endpoint is unavailable.");
      await saveBlockExecutor(blockRef, endpoint.executorName);
      await saveAgentEndpointPreference(preferenceKey, endpoint);
    },
    [agentEndpointsForBlock, navigation, saveAgentEndpointPreference, saveBlockExecutor]
  );

  const liveStatus = useMemo<TaskWorkspaceLiveStatus>(() => {
    if (overviewSelected || !selectedRecordKey) return "idle";
    if (visibleRecordLoad.status === "loading") return "loading";
    if (visibleRecordLoad.status === "error") {
      return "error";
    }
    if (!liveProjection.selectedRun) {
      return "loading";
    }
    if (monitor.subscriptionError || liveProjection.error) return "error";
    if (selectedRecord && !selectedRecord.runnerReadModel) return "unavailable";
    return liveProjection.runnerModel ? "live" : "loading";
  }, [
    liveProjection,
    monitor.subscriptionError,
    overviewSelected,
    visibleRecordLoad.status,
    selectedRecord,
    selectedRecordKey
  ]);
  const liveUnavailableReason =
    liveStatus === "unavailable"
      ? (liveProjection.selectedRun?.item.run.capabilities.prompt.reason ??
        "This run has no live RunnerRecordReadModel.")
      : null;
  const status = workspaceLoad.key === key ? workspaceLoad.status : navigation ? "loading" : "idle";
  const recordError = visibleRecordLoad.key === selectedRecordKey ? visibleRecordLoad.error : null;
  const error =
    history.historyError ??
    (workspaceLoad.key === key ? workspaceLoad.error : null) ??
    recordError ??
    liveProjection.error;

  return useMemo<TaskWorkspaceController>(
    () => ({
      agentEndpointsForBlock,
      agentEndpointsForTask,
      error,
      getRunScrollTop: (recordId) => runScrollPositions.current.get(recordId) ?? 0,
      hasMoreRuns,
      liveStatus,
      liveUnavailableReason,
      loadMoreRuns,
      loadMoreRunsError,
      loadingMoreRuns,
      navigation,
      onRunScrollTopChange: (recordId, scrollTop) => {
        runScrollPositions.current.set(recordId, Math.max(0, scrollTop));
      },
      packageExecutorNames,
      recordError,
      remoteConversation,
      refresh,
      returnToCanvas: history.returnToTaskWorkspaceSource,
      runnerModel: liveProjection.runnerModel,
      saveBlockExecutor,
      saveBlockAgentEndpoint,
      saveBlockPrompt,
      saveTaskExecutor,
      saveTaskAgentEndpoint,
      saveTaskPrompt,
      selectAnnotation,
      selectRun,
      selectedAnnotation,
      selectedRecord,
      selectedRecordId,
      selectedRun: liveProjection.selectedRun,
      selectedAgentEndpointIdForBlock,
      selectedAgentEndpointIdForTask,
      status,
      subscriptionError: monitor.subscriptionError,
      workspace: liveProjection.workspace
    }),
    [
      error,
      agentEndpointsForBlock,
      agentEndpointsForTask,
      hasMoreRuns,
      history.returnToTaskWorkspaceSource,
      liveStatus,
      liveUnavailableReason,
      loadMoreRuns,
      loadMoreRunsError,
      loadingMoreRuns,
      monitor.subscriptionError,
      liveProjection,
      navigation,
      packageExecutorNames,
      recordError,
      remoteConversation,
      refresh,
      saveBlockExecutor,
      saveBlockAgentEndpoint,
      saveBlockPrompt,
      saveTaskExecutor,
      saveTaskAgentEndpoint,
      saveTaskPrompt,
      selectAnnotation,
      selectRun,
      selectedAnnotation,
      selectedRecordId,
      selectedRecord,
      selectedAgentEndpointIdForBlock,
      selectedAgentEndpointIdForTask,
      status
    ]
  );
}
