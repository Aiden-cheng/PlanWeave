import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CanvasAccessPage,
  ProjectAccessPage
} from "@planweave-ai/collaboration-protocol/access/project";
import type {
  CollaborationRegistryPageInput,
  PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";
import { collaborationBridge } from "../bridge.js";

export type UseCollaborationRegistryReadModelsArgs = {
  projectId?: string | null;
  projectPage?: CollaborationRegistryPageInput;
  canvasPage?: CollaborationRegistryPageInput;
  refreshKey?: string | number | boolean;
  api?: CollaborationRegistryReadPort | null;
};

export type CollaborationRegistryReadPort = Pick<
  PlanWeaveCollaborationApi,
  "listCollaborationAuthorizedProjects" | "listCollaborationAuthorizedCanvases"
>;

export type UseCollaborationRegistryReadModelsResult = {
  projects: ProjectAccessPage["items"];
  canvases: CanvasAccessPage["items"];
  projectNextCursor: number | null;
  canvasNextCursor: number | null;
  phase: "idle" | "loading" | "ready" | "error";
  error: string | null;
  refresh: () => Promise<void>;
};

const EMPTY_PAGE: CollaborationRegistryPageInput = {};

function pageInput(
  cursor: number | undefined,
  limit: number | undefined
): CollaborationRegistryPageInput {
  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit })
  };
}

/** Loads Server-authorized registry read models; it never derives scope from local paths. */
export function useCollaborationRegistryReadModels(
  args: UseCollaborationRegistryReadModelsArgs = {}
): UseCollaborationRegistryReadModelsResult {
  const api = args.api === undefined ? collaborationBridge : args.api;
  const [projects, setProjects] = useState<ProjectAccessPage["items"]>([]);
  const [canvases, setCanvases] = useState<CanvasAccessPage["items"]>([]);
  const [projectNextCursor, setProjectNextCursor] = useState<number | null>(null);
  const [canvasNextCursor, setCanvasNextCursor] = useState<number | null>(null);
  const [phase, setPhase] = useState<UseCollaborationRegistryReadModelsResult["phase"]>("idle");
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const projectCursor = args.projectPage?.cursor;
  const projectLimit = args.projectPage?.limit;
  const canvasCursor = args.canvasPage?.cursor;
  const canvasLimit = args.canvasPage?.limit;

  const load = useCallback(async () => {
    const current = ++generation.current;
    if (!api) {
      setProjects([]);
      setCanvases([]);
      setProjectNextCursor(null);
      setCanvasNextCursor(null);
      setError(null);
      setPhase("idle");
      return;
    }
    setPhase("loading");
    setError(null);
    try {
      const projectPage = await api.listCollaborationAuthorizedProjects(
        projectCursor === undefined && projectLimit === undefined
          ? EMPTY_PAGE
          : pageInput(projectCursor, projectLimit)
      );
      const canvasPage = args.projectId
        ? await api.listCollaborationAuthorizedCanvases({
            projectId: args.projectId,
            ...pageInput(canvasCursor, canvasLimit)
          })
        : null;
      if (generation.current !== current) return;
      setProjects(projectPage.items);
      setCanvases(canvasPage?.items ?? []);
      setProjectNextCursor(projectPage.nextCursor);
      setCanvasNextCursor(canvasPage?.nextCursor ?? null);
      setPhase("ready");
    } catch {
      if (generation.current !== current) return;
      setProjects([]);
      setCanvases([]);
      setProjectNextCursor(null);
      setCanvasNextCursor(null);
      setError("collaboration_registry_read_failed");
      setPhase("error");
    }
  }, [api, args.projectId, canvasCursor, canvasLimit, projectCursor, projectLimit]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey explicitly triggers a registry refresh
  useEffect(() => {
    void load();
  }, [load, args.refreshKey]);

  return {
    projects,
    canvases,
    projectNextCursor,
    canvasNextCursor,
    phase,
    error,
    refresh: load
  };
}
