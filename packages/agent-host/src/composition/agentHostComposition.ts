import type { AgentHostStateRepository } from "../state/agentHostState.js";
import type {
  HostTransport,
  HostTransportStatusListener
} from "../transport/hostTransport.js";

export interface AgentHostComposition {
  start(): Promise<void>;
  shutdown(): Promise<void>;
  subscribeStatus(listener: HostTransportStatusListener): () => void;
}

export type AgentHostCompositionOptions = {
  state: Pick<AgentHostStateRepository, "close">;
  transport: Pick<HostTransport, "start" | "stop" | "subscribe">;
};

export function composeAgentHost(options: AgentHostCompositionOptions): AgentHostComposition {
  let startPromise: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;

  return {
    subscribeStatus(listener) {
      return options.transport.subscribe(listener);
    },
    start() {
      if (shutdownPromise) {
        return Promise.reject(new Error("agent_host_composition_already_shutdown"));
      }
      startPromise ??= Promise.resolve().then(() => options.transport.start());
      return startPromise;
    },
    shutdown() {
      shutdownPromise ??= (async () => {
        try {
          if (startPromise) {
            await startPromise;
            await options.transport.stop();
          }
        } finally {
          await options.state.close();
        }
      })();
      return shutdownPromise;
    }
  };
}

export function createNoopAgentHostComposition(): AgentHostComposition {
  return composeAgentHost({
    state: {
      close() {}
    },
    transport: {
      start() {},
      stop() {},
      subscribe(listener) {
        listener({ state: "stopped" });
        return () => {};
      }
    }
  });
}
