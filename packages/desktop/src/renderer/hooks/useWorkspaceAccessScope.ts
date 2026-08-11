import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActiveWorkspaceConnectionStatus } from "@planweave-ai/collaboration-protocol/connection";
import type {
  CollaborationSessionPhase,
  PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";
import { collaborationErrorMessage } from "../collaboration/formatCollaborationError";
import { isCollaborationSessionConnected } from "../collaboration/sessionState";
import { type CurrentCanvasAccessApi, useCurrentCanvasAccess } from "./useCurrentCanvasAccess";

export type WorkspaceAccessScopeApi = CurrentCanvasAccessApi &
  Pick<
    PlanWeaveCollaborationApi,
    "listCollaborationContentBootstrapCandidates" | "getLocalCollaborationScopeCatalog"
  >;

export type WorkspaceAccessScopeOption = {
  key: string;
  projectId: string;
  canvasId: string;
  projectLabel: string;
  canvasLabel: string;
};

type WorkspaceAccessScopeStatus = {
  session: { phase: CollaborationSessionPhase };
  workspaceConnection: { status: ActiveWorkspaceConnectionStatus };
};

function scopeKey(projectId: string, canvasId: string): string {
  return `${projectId}\0${canvasId}`;
}

export function useWorkspaceAccessScope({
  api,
  connectionKey,
  status
}: {
  api: WorkspaceAccessScopeApi | null;
  connectionKey: string | null;
  status: WorkspaceAccessScopeStatus | null;
}) {
  const [options, setOptions] = useState<WorkspaceAccessScopeOption[]>([]);
  const [optionsConnectionKey, setOptionsConnectionKey] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const connected = isCollaborationSessionConnected(status);

  const refreshOptions = useCallback(async () => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    if (!api || !connectionKey || !connected) {
      setOptions([]);
      setOptionsConnectionKey(null);
      setSelectedKey(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const [candidates, catalog] = await Promise.all([
        api.listCollaborationContentBootstrapCandidates(),
        api.getLocalCollaborationScopeCatalog()
      ]);
      if (generationRef.current !== generation) return;

      const nextOptions = candidates.map((candidate) => {
        const localProject = candidate.localReplica
          ? catalog.projects.find(
              (project) => project.projectId === candidate.localReplica?.projectId
            )
          : null;
        const localCanvas = candidate.localReplica
          ? localProject?.canvases.find(
              (canvas) => canvas.canvasId === candidate.localReplica?.canvasId
            )
          : null;
        return {
          key: scopeKey(candidate.projectId, candidate.canvasId),
          projectId: candidate.projectId,
          canvasId: candidate.canvasId,
          projectLabel: localProject?.name ?? candidate.projectId,
          canvasLabel: localCanvas?.name ?? candidate.canvasId
        };
      });
      setOptions(nextOptions);
      setOptionsConnectionKey(connectionKey);
      setSelectedKey((current) =>
        current && nextOptions.some((option) => option.key === current)
          ? current
          : (nextOptions[0]?.key ?? null)
      );
    } catch (cause) {
      if (generationRef.current !== generation) return;
      setOptions([]);
      setOptionsConnectionKey(null);
      setSelectedKey(null);
      setError(collaborationErrorMessage(cause));
    } finally {
      if (generationRef.current === generation) setLoading(false);
    }
  }, [api, connected, connectionKey]);

  useEffect(() => {
    void refreshOptions();
    return () => {
      generationRef.current += 1;
    };
  }, [refreshOptions]);

  const visibleOptions = optionsConnectionKey === connectionKey ? options : [];
  const selectedOption = useMemo(
    () => visibleOptions.find((option) => option.key === selectedKey) ?? null,
    [selectedKey, visibleOptions]
  );
  const access = useCurrentCanvasAccess({
    api,
    canvasId: selectedOption?.canvasId ?? null,
    status
  });

  return {
    options: visibleOptions,
    selectedKey,
    selectedOption,
    select: setSelectedKey,
    loading,
    error,
    refreshOptions,
    access
  };
}
