import type { AgentHostStateRepository } from "../state/agentHostState.js";

export interface AgentHostTransport {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

export interface AgentHostComposition {
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

export type AgentHostCompositionOptions = {
  state: Pick<AgentHostStateRepository, "close">;
  transport: AgentHostTransport;
};

export function composeAgentHost(options: AgentHostCompositionOptions): AgentHostComposition {
  let startPromise: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;

  return {
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
      stop() {}
    }
  });
}
