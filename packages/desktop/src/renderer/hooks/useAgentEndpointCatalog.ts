import type { RemoteAgentEndpoint } from "@planweave-ai/collaboration-protocol/agent-endpoint";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration";
import { collaborationBridge } from "../bridge";
import {
  buildAgentEndpointCatalog,
  type AvailableAgentEndpoint,
  type LogicalAgentEndpointInput
} from "../collaboration/agentEndpointViewModel";

type AgentEndpointCatalogApi = Pick<
  PlanWeaveCollaborationApi,
  "listCollaborationAgentEndpoints" | "onCollaborationObserverSignal"
>;

export const agentEndpointCatalogRefreshIntervalMs = 30_000;

export function useAgentEndpointCatalog(input: {
  enabled: boolean;
  logicalExecutors: readonly LogicalAgentEndpointInput[];
  profileId: string | null;
  projectId: string | null;
  api?: AgentEndpointCatalogApi | null;
}): {
  endpoints: AvailableAgentEndpoint[];
  error: string | null;
  refreshing: boolean;
  refresh: () => Promise<void>;
} {
  const api = input.api === undefined ? collaborationBridge : input.api;
  const [remoteEndpoints, setRemoteEndpoints] = useState<RemoteAgentEndpoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const generationRef = useRef(0);
  const scopeKey =
    input.profileId && input.projectId ? `${input.profileId}:${input.projectId}` : null;
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    const requestScopeKey = scopeKey;
    const canWrite = () =>
      generation === generationRef.current && requestScopeKey === scopeKeyRef.current;
    if (!input.enabled || !requestScopeKey || !api?.listCollaborationAgentEndpoints) {
      setRemoteEndpoints([]);
      setError(null);
      setRefreshing(false);
      return;
    }
    setRefreshing(true);
    setError(null);
    try {
      const result = await api.listCollaborationAgentEndpoints();
      if (canWrite()) setRemoteEndpoints(result.items);
    } catch (caught: unknown) {
      if (canWrite()) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (canWrite()) setRefreshing(false);
    }
  }, [api, input.enabled, scopeKey]);

  useEffect(() => {
    setRemoteEndpoints([]);
    void refresh();
    return () => {
      generationRef.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    if (!input.enabled || !scopeKey || !api) return;
    const refreshFromServerState = () => {
      void refresh();
    };
    const unsubscribeObserver = api.onCollaborationObserverSignal((signal) => {
      if (signal.profileId !== input.profileId || signal.projectId !== input.projectId) return;
      if (
        signal.type === "human.observer.catchup_required" ||
        (signal.type === "human.observer.event" && signal.event.kind === "remote_run")
      ) {
        refreshFromServerState();
      }
    });
    const interval = window.setInterval(
      refreshFromServerState,
      agentEndpointCatalogRefreshIntervalMs
    );
    return () => {
      window.clearInterval(interval);
      unsubscribeObserver();
    };
  }, [api, input.enabled, input.profileId, input.projectId, refresh, scopeKey]);

  const endpoints = useMemo(() => {
    const catalog = buildAgentEndpointCatalog({
      logicalExecutors: input.logicalExecutors,
      remote: remoteEndpoints
    });
    return error
      ? catalog.map((endpoint) =>
          endpoint.source === "remote"
            ? {
                ...endpoint,
                available: false,
                unavailableReason: "agent_endpoint_request_failed"
              }
            : endpoint
        )
      : catalog;
  }, [error, input.logicalExecutors, remoteEndpoints]);

  return { endpoints, error, refreshing, refresh };
}
