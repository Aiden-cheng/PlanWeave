import type { AcpTimelineItem } from "@planweave-ai/runtime";
import { projectRemoteAcpTimeline } from "@planweave-ai/runtime/browser";
import type {
  RemoteEventReplay,
  RemoteOperationObservation
} from "@planweave-ai/collaboration-protocol/remote-run";
import { useEffect, useMemo, useState } from "react";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration";

type RemoteConversationApi = Pick<
  PlanWeaveCollaborationApi,
  | "observeCollaborationRemoteOperation"
  | "onCollaborationObserverSignal"
  | "replayCollaborationRemoteOperationEvents"
>;

export type RemoteTaskWorkspaceConversation = {
  blockRef: string;
  error: string | null;
  operationId: string;
  state: RemoteOperationObservation["state"] | "loading";
  timeline: readonly AcpTimelineItem[];
};

const terminalStates = new Set<RemoteOperationObservation["state"]>([
  "completed",
  "failed",
  "cancelled"
]);

async function replayAll(
  api: RemoteConversationApi,
  operationId: string
): Promise<RemoteEventReplay["events"]> {
  const events: RemoteEventReplay["events"] = [];
  let afterCursor = 0;
  for (;;) {
    const replay = await api.replayCollaborationRemoteOperationEvents({
      operationId,
      query: { afterCursor }
    });
    events.push(...replay.events);
    if (!replay.hasMore || replay.cursor <= afterCursor) return events;
    afterCursor = replay.cursor;
  }
}

export function useRemoteTaskWorkspaceConversation(input: {
  api: RemoteConversationApi | null;
  blockRef: string | null;
  operationId: string | null;
  onTerminal: () => void;
}): RemoteTaskWorkspaceConversation | null {
  const [snapshot, setSnapshot] = useState<{
    key: string;
    error: string | null;
    events: RemoteEventReplay["events"];
    state: RemoteTaskWorkspaceConversation["state"];
  } | null>(null);
  const key =
    input.operationId && input.blockRef ? `${input.operationId}\u0000${input.blockRef}` : null;

  useEffect(() => {
    if (!input.api || !input.operationId || !input.blockRef || !key) {
      setSnapshot(null);
      return;
    }
    const api = input.api;
    const operationId = input.operationId;
    let disposed = false;
    let refreshInFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (!disposed) timer = setTimeout(() => void refresh(), 1_000);
    };
    const refresh = async () => {
      if (disposed || refreshInFlight) return;
      refreshInFlight = true;
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        const [observation, events] = await Promise.all([
          api.observeCollaborationRemoteOperation({ operationId }),
          replayAll(api, operationId)
        ]);
        if (disposed) return;
        setSnapshot({
          key,
          error: observation.failure
            ? `${observation.failure.message} (${observation.failure.code})`
            : null,
          events,
          state: observation.state
        });
        if (terminalStates.has(observation.state)) input.onTerminal();
        else schedule();
      } catch (error) {
        if (disposed) return;
        setSnapshot({
          key,
          error: error instanceof Error ? error.message : String(error),
          events: [],
          state: "loading"
        });
        schedule();
      } finally {
        refreshInFlight = false;
      }
    };
    setSnapshot({ key, error: null, events: [], state: "loading" });
    const unsubscribe = api.onCollaborationObserverSignal((signal) => {
      if (signal.type === "human.observer.event" && signal.event.kind === "remote_run") {
        void refresh();
      }
    });
    void refresh();
    return () => {
      disposed = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [input.api, input.blockRef, input.onTerminal, input.operationId, key]);

  return useMemo(() => {
    if (!key || !input.blockRef || !input.operationId) return null;
    const visible = snapshot?.key === key ? snapshot : null;
    return {
      blockRef: input.blockRef,
      error: visible?.error ?? null,
      operationId: input.operationId,
      state: visible?.state ?? "loading",
      timeline: projectRemoteAcpTimeline(visible?.events ?? [])
    };
  }, [input.blockRef, input.operationId, key, snapshot]);
}
