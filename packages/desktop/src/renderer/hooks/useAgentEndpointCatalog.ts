import type { RemoteAgentEndpoint } from "@planweave-ai/collaboration-protocol/agent-endpoint";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration";
import { collaborationBridge } from "../bridge";
import {
  buildAgentEndpointCatalog,
  type AvailableAgentEndpoint,
  type LogicalAgentEndpointInput
} from "../collaboration/agentEndpointViewModel";

export function useAgentEndpointCatalog(input: {
  enabled: boolean;
  logicalExecutors: readonly LogicalAgentEndpointInput[];
  scopeKey: string | null;
  api?: PlanWeaveCollaborationApi | null;
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
  const scopeKeyRef = useRef(input.scopeKey);
  scopeKeyRef.current = input.scopeKey;

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    const requestScopeKey = input.scopeKey;
    const canWrite = () =>
      generation === generationRef.current && requestScopeKey === scopeKeyRef.current;
    if (!input.enabled || !api?.listCollaborationAgentEndpoints) {
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
  }, [api, input.enabled, input.scopeKey]);

  useEffect(() => {
    setRemoteEndpoints([]);
    void refresh();
    return () => {
      generationRef.current += 1;
    };
  }, [refresh]);

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
