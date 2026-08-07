import { WebSocket } from "ws";
import type { HostReadinessObservation } from "@planweave-ai/agent-host-protocol";
import {
  parseAgentHostCapabilities,
  parseAgentHostDispatchResult,
  parseAgentHostServerEvent,
  serializeAgentHostEvent,
  serializeAgentHostHello,
  type ServerEvent
} from "../protocol.js";
import { HttpArtifactClient } from "../artifacts/httpArtifactTransfer.js";
import {
  AgentHostExecutionError,
  AgentHostSessionLoadError,
  type AgentHostExecutionContext,
  type AgentHostExecutor
} from "../execution/agentHostExecutor.js";
import type { DurableAcpInteractionRelay } from "../execution/durableAcpRelay.js";
import type { AgentHostExecution, AgentHostStateRepository } from "../state/agentHostState.js";
import {
  type HostTransport,
  type HostTransportClock,
  type HostTransportLimits,
  type HostTransportLogger,
  type HostTransportStatus,
  type HostTransportStatusListener,
  parseHostTransportLimits,
  systemHostTransportClock
} from "./hostTransport.js";
import {
  parseReconnectBackoffOptions,
  reconnectDelay,
  type ReconnectBackoffOptions
} from "./reconnectBackoff.js";

export type AgentHostClientOptions = {
  serverUrl: string;
  hostId: string;
  workspaceId: string;
  token: string;
  capabilities: readonly string[];
  capacity: number;
  readiness: HostReadinessObservation;
  state: AgentHostStateRepository;
  executor: AgentHostExecutor;
  interactionRelay?: Pick<DurableAcpInteractionRelay, "accept">;
  allowInsecureTransport?: boolean;
  ca?: string[];
  request?: typeof fetch;
  reconnect?: Partial<ReconnectBackoffOptions>;
  clock?: HostTransportClock;
  random?: () => number;
  limits?: Partial<HostTransportLimits>;
  logger?: HostTransportLogger;
  onProtocolError?(event: Extract<ServerEvent, { type: "protocol.error" }>): void;
};

type ActiveExecution = {
  execution: AgentHostExecution;
  controller: AbortController;
};

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
  if (error instanceof AgentHostExecutionError) return error.failure;
  if (
    error instanceof Error &&
    (error.message.startsWith("artifact_upload_failed:") ||
      error.message.startsWith("artifact_download_failed:") ||
      error.message.startsWith("artifact_download_"))
  ) {
    return {
      code: "artifact_upload_failed",
      message: "The Agent Host could not transfer an execution artifact.",
      retryable: true
    };
  }
  return {
    code: "executor_failed",
    message: "The Agent Host executor failed.",
    retryable: false
  };
}

export class AgentHostClient implements HostTransport {
  private readonly baseUrl: URL;
  private readonly capabilities: string[];
  private readonly artifacts: HttpArtifactClient;
  private readonly active = new Map<number, ActiveExecution>();
  private readonly runs = new Set<Promise<void>>();
  private socket?: WebSocket;
  private readonly clock: HostTransportClock;
  private readonly limits: HostTransportLimits;
  private readonly reconnect: ReconnectBackoffOptions;
  private readonly listeners = new Set<HostTransportStatusListener>();
  private heartbeatTimer?: unknown;
  private reconnectTimer?: unknown;
  private currentStatus: HostTransportStatus = { state: "stopped" };
  private reconnectAttempt = 0;
  private queuedMessages = 0;
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
    if (!options.hostId || !options.workspaceId || !options.token)
      throw new Error("agent_host_credentials_required");
    if (!Number.isInteger(options.capacity) || options.capacity < 1 || options.capacity > 128) {
      throw new Error("agent_host_capacity_out_of_range");
    }
    this.clock = options.clock ?? systemHostTransportClock;
    this.limits = parseHostTransportLimits(options.limits);
    this.reconnect = parseReconnectBackoffOptions(options.reconnect);
    this.capabilities = parseAgentHostCapabilities(options.capabilities);
    this.artifacts = new HttpArtifactClient({
      baseUrl: this.baseUrl,
      hostId: options.hostId,
      workspaceId: options.workspaceId,
      token: options.token,
      request: options.request
    });
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.options.state.recoverInterruptedExecutions();
    this.connect();
  }

  status(): HostTransportStatus {
    return this.currentStatus;
  }

  subscribe(listener: HostTransportStatusListener): () => void {
    this.listeners.add(listener);
    listener(this.currentStatus);
    return () => this.listeners.delete(listener);
  }

  async stop(): Promise<void> {
    if (this.currentStatus.state === "stopped") return;
    this.stopped = true;
    this.welcomed = false;
    if (this.reconnectTimer) this.clock.clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) this.clock.clearTimeout(this.heartbeatTimer);
    for (const { controller } of this.active.values()) controller.abort();
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await this.waitBounded(
        new Promise<void>((resolve) => {
          socket.once("close", () => resolve());
          socket.close(1000, "host shutdown");
        })
      );
    }
    await this.waitBounded(Promise.allSettled([...this.runs]).then(() => undefined));
    this.transition({ state: "stopped" });
  }

  private connect(): void {
    if (this.stopped) return;
    this.transition({ state: "connecting", attempt: this.reconnectAttempt + 1 });
    const url = endpoint(
      this.baseUrl,
      `/agent-hosts/${encodeURIComponent(this.options.hostId)}/connect`,
      true
    );
    url.searchParams.set("workspaceId", this.options.workspaceId);
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.options.token}` },
      maxPayload: this.limits.maxPayloadBytes,
      ca: this.options.ca
    });
    this.socket = socket;
    socket.on("open", () => {
      const hello = serializeAgentHostHello({
        type: "host.hello",
        protocolVersion: 1,
        lastAcknowledgedSequence: this.options.state.lastAcknowledgedSequence(),
        capabilities: this.capabilities,
        capacity: this.options.capacity,
        readiness: this.options.readiness
      });
      socket.send(hello);
    });
    socket.on("message", (data, isBinary) => {
      if (
        Buffer.byteLength(data.toString()) > this.limits.maxPayloadBytes ||
        ++this.queuedMessages > this.limits.maxQueuedMessages
      ) {
        this.transition({ state: "degraded", reason: "inbound_backpressure" });
        socket.close(4009, "inbound backpressure");
        return;
      }
      this.processing = this.processing
        .then(async () => {
          if (isBinary) throw new Error("binary_messages_not_supported");
          const event = parseAgentHostServerEvent(JSON.parse(data.toString()));
          await this.handleServerEvent(event);
        })
        .catch(() => {
          this.transition({ state: "degraded", reason: "invalid_server_event" });
          this.stopped = true;
          socket.close(4003, "server event rejected");
        })
        .finally(() => this.queuedMessages--);
    });
    socket.on("unexpected-response", (_request, response) => {
      if (response.statusCode === 401 || response.statusCode === 403) {
        this.stopped = true;
        this.transition({ state: "auth-failed", reason: "credential_rejected" });
      } else {
        this.stopped = true;
        this.transition({ state: "degraded", reason: "upgrade_rejected" });
      }
      socket.terminate();
    });
    socket.on("error", () => socket.terminate());
    socket.on("close", (code) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.welcomed = false;
      if (this.heartbeatTimer) this.clock.clearTimeout(this.heartbeatTimer);
      if (!this.stopped && code === 4001) {
        this.stopped = true;
        this.transition({ state: "degraded", reason: "duplicate_host_connection" });
        return;
      }
      if (!this.stopped) {
        const attempt = ++this.reconnectAttempt;
        const delayMs = reconnectDelay(attempt, this.options.random ?? Math.random, this.reconnect);
        this.transition({
          state: "backing-off",
          attempt,
          delayMs,
          retryAt: new Date(this.clock.now().getTime() + delayMs).toISOString()
        });
        this.reconnectTimer = this.clock.setTimeout(() => this.connect(), delayMs);
      }
    });
  }

  private async handleServerEvent(event: ServerEvent): Promise<void> {
    switch (event.type) {
      case "host.welcome":
        this.welcomed = true;
        this.reconnectAttempt = 0;
        this.transition({ state: "connected", connectedAt: this.clock.now().toISOString() });
        this.serverClockOffsetMs = Date.parse(event.serverTime) - this.clock.now().getTime();
        this.abandonExpiredExecutions();
        this.startHeartbeat(event.heartbeatIntervalMs);
        this.flushEvents();
        this.pump();
        return;
      case "mailbox.message":
        this.options.state.receive(event);
        {
          const cancelled = this.options.interactionRelay?.accept(event.command);
          if (cancelled) {
            for (const active of this.active.values()) {
              if (
                active.execution.command.dispatchId === cancelled.dispatchId &&
                active.execution.command.leaseId === cancelled.leaseId &&
                active.execution.command.executionAttemptId === cancelled.executionAttemptId
              ) {
                active.controller.abort();
              }
            }
          }
        }
        this.flushEvents();
        this.pump();
        return;
      case "host.event_ack":
        this.options.state.acknowledgeEvent(event.messageId);
        this.flushEvents();
        return;
      case "lease.renewed":
        this.options.state.renewLease(
          event.dispatchId,
          event.leaseId,
          event.executionAttemptId,
          event.leaseExpiresAt
        );
        return;
      case "protocol.error":
        this.options.onProtocolError?.(event);
        this.stopped = true;
        // Preserve Server code + public message so Desktop connection-status can surface them.
        this.transition({
          state: "degraded",
          reason: `${event.code}: ${event.message}`.slice(0, 256)
        });
        this.socket?.close(4003, event.code.slice(0, 123));
        return;
    }
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) this.clock.clearTimeout(this.heartbeatTimer);
    const send = () => {
      this.abandonExpiredExecutions();
      this.send(
        this.options.state.queueHeartbeat(this.options.state.activeLeases(), this.options.readiness)
      );
      this.heartbeatTimer = this.clock.setTimeout(send, intervalMs);
    };
    send();
  }

  private flushEvents(): void {
    for (const event of this.options.state.pendingEvents(this.limits.maxOutboundBatch))
      this.send(event);
  }

  private send(event: unknown): void {
    if (!this.welcomed || this.socket?.readyState !== WebSocket.OPEN) return;
    const payload = serializeAgentHostEvent(event);
    if (Buffer.byteLength(payload) > this.limits.maxPayloadBytes)
      throw new Error("agent_host_outbound_payload_too_large");
    if (this.socket.bufferedAmount + Buffer.byteLength(payload) > this.limits.maxBufferedBytes)
      return;
    this.socket.send(payload);
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
            active.execution.command.leaseId === cancellation.command.leaseId &&
            active.execution.command.executionAttemptId === cancellation.command.executionAttemptId
          ) {
            active.controller.abort();
          }
        }
      }
    }
    this.flushEvents();

    const available = this.options.capacity - this.active.size;
    for (const pending of this.options.state.pendingResumptions(available || 1)) {
      if (this.active.size >= this.options.capacity) break;
      const resumption = this.options.state.startResumption(pending.sequence);
      if (!resumption) continue;
      this.launch(resumption.execution, { kind: "load", sessionId: resumption.sessionId });
    }
    const remaining = this.options.capacity - this.active.size;
    for (const pending of this.options.state.pendingExecutions(remaining || 1)) {
      if (this.active.size >= this.options.capacity) break;
      const execution = this.options.state.startExecution(pending.sequence);
      if (!execution) continue;
      this.launch(execution, { kind: "new" });
    }
  }

  private launch(
    execution: AgentHostExecution,
    sessionStart: AgentHostExecutionContext["sessionStart"]
  ): void {
    const controller = new AbortController();
    this.active.set(execution.sequence, { execution, controller });
    this.flushEvents();
    const run = this.run(execution, controller, sessionStart);
    this.runs.add(run);
    void run.then(
      () => this.runs.delete(run),
      () => this.runs.delete(run)
    );
  }

  private abandonExpiredExecutions(): void {
    const expired = this.options.state.abandonExpiredExecutions(
      new Date(this.clock.now().getTime() + this.serverClockOffsetMs)
    );
    for (const execution of expired) this.active.get(execution.sequence)?.controller.abort();
  }

  private async run(
    execution: AgentHostExecution,
    controller: AbortController,
    sessionStart: AgentHostExecutionContext["sessionStart"]
  ): Promise<void> {
    try {
      if (execution.command.envelope.workspaceId !== this.options.workspaceId) {
        throw new AgentHostExecutionError({
          code: "host_workspace_mismatch",
          message: "The execution envelope workspace does not match the local Host credential.",
          retryable: false
        });
      }
      const result = parseAgentHostDispatchResult(
        await this.options.executor.execute(execution.command, {
          signal: controller.signal,
          executionKey: `${execution.command.dispatchId}:${execution.command.leaseId}:${execution.command.executionAttemptId}`,
          artifacts: this.artifacts.forExecution(
            execution.command,
            (evidence) =>
              this.options.state.recordArtifactTransfer(
                execution.sequence,
                execution.command.leaseId,
                evidence
              ),
            controller.signal
          ),
          sessionStart
        })
      );
      if (this.stopped) return;
      this.options.state.completeExecution(execution.sequence, result);
    } catch (error) {
      if (this.stopped) return;
      if (error instanceof AgentHostSessionLoadError && !controller.signal.aborted) {
        this.options.state.failResumption(execution.sequence);
        return;
      }
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

  private transition(status: HostTransportStatus): void {
    this.currentStatus = status;
    this.options.logger?.log({
      level: status.state === "degraded" || status.state === "auth-failed" ? "warn" : "debug",
      event: "host_transport_state",
      state: status.state,
      reason: "reason" in status ? status.reason : undefined
    });
    for (const listener of this.listeners) listener(status);
  }

  private async waitBounded(operation: Promise<void>): Promise<void> {
    let timer: unknown;
    const timedOut = await Promise.race([
      operation.then(() => false),
      new Promise<true>((resolve) => {
        timer = this.clock.setTimeout(() => resolve(true), this.limits.shutdownTimeoutMs);
      })
    ]);
    if (timer) this.clock.clearTimeout(timer);
    if (timedOut) {
      throw new Error("agent_host_transport_shutdown_timeout");
    }
  }
}
