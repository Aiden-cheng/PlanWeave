import { useEffect, useState } from "react";
import { collaborationBridge } from "../bridge";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../../shared/collaboration.js";

export type UseCollaborationStatusArgs = {
  /** Injected bridge for tests; defaults to window.planweaveCollaboration. */
  api?: PlanWeaveCollaborationApi | null;
};

export type UseCollaborationStatusResult = {
  status: CollaborationStatus | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

/**
 * Lightweight status subscription for shell people/connect UI.
 * Does not open observer sockets; session lifecycle stays in main.
 */
export function useCollaborationStatus(
  args: UseCollaborationStatusArgs = {}
): UseCollaborationStatusResult {
  const api = args.api === undefined ? collaborationBridge : args.api;
  const [status, setStatus] = useState<CollaborationStatus | null>(null);
  const [loading, setLoading] = useState(Boolean(api));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) {
      setStatus(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    const load = async () => {
      try {
        const next = await api.getCollaborationStatus();
        if (!cancelled) {
          setStatus(next);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "collaboration_status_failed");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();
    const unsubscribe = api.onCollaborationStatusChanged((next) => {
      setStatus(next);
      setError(null);
      setLoading(false);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api]);

  return {
    status,
    loading,
    error,
    refresh: async () => {
      if (!api) return;
      setLoading(true);
      try {
        const next = await api.getCollaborationStatus();
        setStatus(next);
        setError(null);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "collaboration_status_failed");
      } finally {
        setLoading(false);
      }
    }
  };
}
