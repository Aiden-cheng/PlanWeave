import { createHash, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { z } from "zod";
import { AgentHostState, type AgentHostExecution } from "./agentHostState.js";
import {
  artifactRefSchema,
  capabilitiesSchema,
  dispatchResultSchema,
  hostEventSchema,
  hostHelloSchema,
  serverEventSchema,
  type ProtocolDispatchResult,
  type ServerEvent
} from "./protocol.js";

export type AgentHostArtifactInput = {
  bytes: Uint8Array;
  mediaType: string;
};

export type AgentHostExecutionContext = {
  signal: AbortSignal;
  executionKey: string;
  uploadArtifact(input: AgentHostArtifactInput): Promise<string>;
};

export type AgentHostExecutor = {
  execute(
    execution: AgentHostExecution,
    context: AgentHostExecutionContext
  ): Promise<ProtocolDispatchResult>;
};

export type AgentHostClientOptions = {
  serverUrl: string;
  hostId: string;
  token: string;
  capabilities: readonly string[];
  capacity: number;
  state: AgentHostState;
  executor: AgentHostExecutor;
  allowInsecureTransport?: boolean;
  reconnectDelayMs?: number;
  onProtocolError?(event: Extract<ServerEvent, { type: "protocol.error" }>): void;
};

type ActiveExecution = {
  execution: AgentHostExecution;
  controller: AbortController;
};

const uploadResponseSchema = z.object({ ref: artifactRefSchema });

function endpoint(base: URL, path: string, websocket: boolean): URL {
  const result = new URL(base.origin);
  result.protocol = websocket ? (base.protocol === "https:" ? "wss:" : "ws:") : base.protocol;
  result.pathname = path;
  return result;
}

function executionFailure(error: unknown, aborted: boolean) {
  if (aborted) {
    return {
      code: "execution_cancelled",
      message: "The execution was cancelled by the coordinator.",
      retryable: false
    };
  }
  const retryable = error instanceof Error && error.message.startsWith("artifact_upload_failed:");
  return {
    code: "executor_failed",
    message: error instanceof Error ? error.message : "The Agent Host executor failed.",
    retryable
  };
}

export class AgentHostClient {
  private readonly baseUrl: URL;
  private readonly capabilities: string[];
  private readonly active = new Map<number, ActiveExecution>();
  private readonly runs = new Set<Promise<void>>();
  private socket?: WebSocket;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private processing = Promise.resolve();
  private welcomed = false;
  private stopped = true;
  private serverClockOffsetMs = 0;

  constructor(private readonly options: AgentHostClientOptions) {
    this.baseUrl = new URL(options.serverUrl);
    if (!["http:", "https:"].includes(this.baseUrl.protocol)) {
      throw new Error("agent_host_server_url_must_be_http");
    }
    if (this.baseUrl.protocol !== "https:" && !options.allowInsecureTransport) {
      throw new Error("agent_host_secure_transport_required");
    }
    if (!options.hostId || !options.token) throw new Error("agent_host_credentials_required");
    if (!Number.isInteger(options.capacity) || options.capacity < 1 || options.capacity > 128) {
      throw new Error("agent_host_capacity_out_of_range");
    }
    if (
      !Number.isInteger(options.reconnectDelayMs ?? 1000) ||
      (options.reconnectDelayMs ?? 1000) < 1
    ) {
      throw new Error("agent_host_reconnect_delay_invalid");
    }
    this.capabilities = capabilitiesSchema.parse(options.capabilities);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.options.state.recoverInterruptedExecutions();
    this.connect();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.welcomed = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const { controller } of this.active.values()) controller.abort();
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.close(1000, "host shutdown");
      });
    }
    await Promise.allSettled([...this.runs]);
  }

  private connect(): void {
    if (this.stopped) return;
    const url = endpoint(
      this.baseUrl,
      `/agent-hosts/${encodeURIComponent(this.options.hostId)}/connect`,
      true
    );
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.options.token}` }
    });
    this.socket = socket;
    socket.on("open", () => {
      const hello = hostHelloSchema.parse({
        type: "host.hello",
        protocolVersion: 1,
        lastAcknowledgedSequence: this.options.state.lastAcknowledgedSequence(),
        capabilities: this.capabilities,
        capacity: this.options.capacity
      });
      socket.send(JSON.stringify(hello));
    });
    socket.on("message", (data, isBinary) => {
      this.processing = this.processing
        .then(async () => {
          if (isBinary) throw new Error("binary_messages_not_supported");
          const event = serverEventSchema.parse(JSON.parse(data.toString()));
          await this.handleServerEvent(event);
        })
        .catch(() => socket.close(4003, "server event rejected"));
    });
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.welcomed = false;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(
          () => this.connect(),
          this.options.reconnectDelayMs ?? 1000
        );
      }
    });
  }

  private async handleServerEvent(event: ServerEvent): Promise<void> {
    switch (event.type) {
      case "host.welcome":
        this.welcomed = true;
        this.serverClockOffsetMs = Date.parse(event.serverTime) - Date.now();
        this.abandonExpiredExecutions();
        this.startHeartbeat(event.heartbeatIntervalMs);
        this.flushEvents();
        this.pump();
        return;
      case "mailbox.message":
        this.options.state.receive(event);
        this.flushEvents();
        this.pump();
        return;
      case "host.event_ack":
        this.options.state.acknowledgeEvent(event.messageId);
        return;
      case "lease.renewed":
        this.options.state.renewLease(event.dispatchId, event.leaseId, event.leaseExpiresAt);
        return;
      case "protocol.error":
        this.options.onProtocolError?.(event);
        return;
    }
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const send = () => {
      this.abandonExpiredExecutions();
      this.send(
        hostEventSchema.parse({
          type: "host.heartbeat",
          messageId: randomUUID(),
          activeLeases: this.options.state.activeLeases()
        })
      );
    };
    send();
    this.heartbeatTimer = setInterval(send, intervalMs);
  }

  private flushEvents(): void {
    for (const event of this.options.state.pendingEvents()) this.send(event);
  }

  private send(event: unknown): void {
    if (!this.welcomed || this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(hostEventSchema.parse(event)));
  }

  private pump(): void {
    if (!this.welcomed || this.stopped) return;
    this.abandonExpiredExecutions();
    for (const cancellation of this.options.state.pendingCancellations()) {
      const outcome = this.options.state.applyCancellation(cancellation.sequence);
      if (outcome.shouldAbort) {
        for (const active of this.active.values()) {
          if (
            active.execution.command.dispatchId === cancellation.command.dispatchId &&
            active.execution.command.leaseId === cancellation.command.leaseId
          ) {
            active.controller.abort();
          }
        }
      }
    }
    this.flushEvents();

    const available = this.options.capacity - this.active.size;
    for (const pending of this.options.state.pendingExecutions(available || 1)) {
      if (this.active.size >= this.options.capacity) break;
      const execution = this.options.state.startExecution(pending.sequence);
      if (!execution) continue;
      const controller = new AbortController();
      this.active.set(execution.sequence, { execution, controller });
      this.flushEvents();
      const run = this.run(execution, controller);
      this.runs.add(run);
      void run.then(
        () => this.runs.delete(run),
        () => this.runs.delete(run)
      );
    }
  }

  private abandonExpiredExecutions(): void {
    const expired = this.options.state.abandonExpiredExecutions(
      new Date(Date.now() + this.serverClockOffsetMs)
    );
    for (const execution of expired) this.active.get(execution.sequence)?.controller.abort();
  }

  private async run(execution: AgentHostExecution, controller: AbortController): Promise<void> {
    try {
      const result = dispatchResultSchema.parse(
        await this.options.executor.execute(execution, {
          signal: controller.signal,
          executionKey: `${execution.command.dispatchId}:${execution.command.leaseId}`,
          uploadArtifact: (input) => this.uploadArtifact(input)
        })
      );
      if (this.stopped) return;
      this.options.state.completeExecution(execution.sequence, result);
    } catch (error) {
      if (this.stopped) return;
      this.options.state.failExecution(
        execution.sequence,
        executionFailure(error, controller.signal.aborted)
      );
    } finally {
      this.active.delete(execution.sequence);
      this.flushEvents();
      this.pump();
    }
  }

  private async uploadArtifact(input: AgentHostArtifactInput): Promise<string> {
    const bytes = Buffer.from(input.bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const url = endpoint(
      this.baseUrl,
      `/agent-hosts/${encodeURIComponent(this.options.hostId)}/artifacts/${sha256}`,
      false
    );
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        "content-type": input.mediaType,
        "content-length": String(bytes.byteLength)
      },
      body: bytes
    });
    if (!response.ok) throw new Error(`artifact_upload_failed:${response.status}`);
    const ref = uploadResponseSchema.parse(await response.json()).ref;
    if (ref !== `artifact:sha256:${sha256}`) throw new Error("artifact_upload_ref_mismatch");
    return ref;
  }
}
