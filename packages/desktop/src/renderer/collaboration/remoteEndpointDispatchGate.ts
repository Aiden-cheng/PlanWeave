type DispatchEntry = {
  state: "executing" | "waiting";
  settled: Promise<void>;
  release: () => void;
};

function dispatchErrorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  if (!(error instanceof Error)) return null;
  if (error.message === "agent_endpoint_unavailable") return error.message;
  return error.message.includes("dispatch") && error.message.includes("agent_endpoint_unavailable")
    ? "agent_endpoint_unavailable"
    : null;
}

function createEntry(): DispatchEntry {
  let release: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { state: "executing", settled, release };
}

/**
 * Preserve optimistic parallel dispatch while applying backpressure after an exact Endpoint
 * reports temporary unavailability. Earlier work on the same Endpoint owns the retry order;
 * unrelated Endpoints remain independent.
 */
export function createRemoteEndpointDispatchGate(): {
  run: <T>(input: {
    endpointId: string;
    execute: () => Promise<T>;
    signal?: AbortSignal;
  }) => Promise<T>;
} {
  const active = new Map<string, Set<DispatchEntry>>();

  return {
    run: async <T>(input: {
      endpointId: string;
      execute: () => Promise<T>;
      signal?: AbortSignal;
    }): Promise<T> => {
      const entry = createEntry();
      const entries = active.get(input.endpointId) ?? new Set<DispatchEntry>();
      entries.add(entry);
      active.set(input.endpointId, entries);
      try {
        while (true) {
          if (input.signal?.aborted) throw new Error("claim_bus_cancelled");
          entry.state = "executing";
          try {
            return await input.execute();
          } catch (error) {
            if (dispatchErrorCode(error) !== "agent_endpoint_unavailable") {
              throw error;
            }
            entry.state = "waiting";
            const occupying = [...entries].filter(
              (candidate) => candidate !== entry && candidate.state === "executing"
            );
            if (occupying.length === 0) throw error;
            await Promise.race(occupying.map((candidate) => candidate.settled));
          }
        }
      } finally {
        entry.release();
        entries.delete(entry);
        if (entries.size === 0) active.delete(input.endpointId);
      }
    }
  };
}
