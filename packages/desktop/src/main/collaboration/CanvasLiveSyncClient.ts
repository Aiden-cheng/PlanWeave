import {
  CANVAS_LIVE_SYNC_MAX_FRAME_BYTES,
  CANVAS_LIVE_SYNC_PROTOCOL_VERSION
} from "@planweave-ai/collaboration-protocol/core/limits";
import {
  canvasLiveSyncHelloSchema,
  canvasLiveSyncServerMessageSchema,
  type CanvasLiveSyncServerMessage
} from "@planweave-ai/collaboration-protocol/canvas/live-sync";
import { type CanvasRevision } from "@planweave-ai/collaboration-protocol/canvas/commands";
import { type CollaborationConnectionProfile } from "@planweave-ai/collaboration-protocol/connection";
import { CollaborationClientError } from "./collaborationErrors.js";
import { reconnectDelay } from "./reconnectBackoff.js";
import { redactCollaborationText } from "./redaction.js";
import { derivedWebSocketOrigin } from "./webSocketOrigin.js";
import type {
  CollaborationClientClock,
  CollaborationCredentialPort,
  CollaborationWebSocketConstructor,
  CollaborationWebSocketLike
} from "./collaborationClientTypes.js";

export type CanvasLiveSyncStatus =
  | { readonly state: "stopped" }
  | { readonly state: "connecting"; readonly canvasId: string; readonly attempt: number }
  | { readonly state: "connected"; readonly canvasId: string }
  | {
      readonly state: "reconnecting";
      readonly canvasId: string;
      readonly attempt: number;
      readonly delayMs: number;
    }
  | { readonly state: "catchup_required"; readonly canvasId: string }
  | {
      readonly state: "catchup_recovering";
      readonly canvasId: string;
      readonly attempt: number;
      readonly delayMs: number;
    }
  | { readonly state: "auth_expired"; readonly canvasId: string; readonly code: string }
  | { readonly state: "access_denied"; readonly canvasId: string; readonly code: string }
  | { readonly state: "failed"; readonly canvasId: string; readonly code: string };

export type CanvasLiveSyncHandlers = {
  onMessage?(message: CanvasLiveSyncServerMessage): void;
  onStatus?(status: CanvasLiveSyncStatus): void;
};

export type CanvasLiveSyncClientOptions = {
  profile: CollaborationConnectionProfile;
  credential: CollaborationCredentialPort;
  WebSocketImpl?: CollaborationWebSocketConstructor;
  clock: CollaborationClientClock;
  random: () => number;
  reconnectInitialDelayMs: number;
  reconnectMaxDelayMs: number;
  logger?: { warn?(message: string): void; error?(message: string): void };
};

function textFromEvent(event: unknown): string {
  const data =
    typeof event === "object" && event !== null && "data" in event
      ? (event as { data: unknown }).data
      : event;
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  throw new CollaborationClientError({
    kind: "protocol",
    code: "collaboration_live_sync_payload_type",
    message: "Canvas live sync payload must be text."
  });
}

/**
 * Main-process-only read-only Canvas journal notification transport.
 * Connection ownership is singular; application handlers attach via subscribe() so
 * multiple consumers (replica worker + renderer signals) never overwrite each other.
 * Hello cursor advances only through acknowledgeAppliedRevision after local materialize.
 */
export class CanvasLiveSyncClient {
  private readonly profile: CollaborationConnectionProfile;
  private readonly credential: CollaborationCredentialPort;
  private readonly WebSocketImpl?: CollaborationWebSocketConstructor;
  private readonly clock: CollaborationClientClock;
  private readonly random: () => number;
  private readonly reconnectInitialDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly logger?: CanvasLiveSyncClientOptions["logger"];
  private socket?: CollaborationWebSocketLike;
  private readonly messageListeners = new Set<(message: CanvasLiveSyncServerMessage) => void>();
  private readonly statusListeners = new Set<(status: CanvasLiveSyncStatus) => void>();
  private status: CanvasLiveSyncStatus = { state: "stopped" };
  private canvasId: string | null = null;
  /** Last revision successfully applied by the replica store (hello cursor). */
  private lastRevision: CanvasRevision | null = null;
  private wanted = false;
  private disposed = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: unknown;
  private generation = 0;

  constructor(options: CanvasLiveSyncClientOptions) {
    this.profile = options.profile;
    this.credential = options.credential;
    this.WebSocketImpl = options.WebSocketImpl;
    this.clock = options.clock;
    this.random = options.random;
    this.reconnectInitialDelayMs = options.reconnectInitialDelayMs;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs;
    this.logger = options.logger;
  }

  state(): CanvasLiveSyncStatus {
    return this.status;
  }

  canvas(): string | null {
    return this.canvasId;
  }

  /** Last revision encoded in hello — only advances after acknowledgeAppliedRevision. */
  helloRevision(): CanvasRevision | null {
    return this.lastRevision;
  }

  /**
   * Attach non-owning listeners. Safe to call while a connection is already open;
   * does not restart the socket or replace other listeners.
   */
  subscribe(handlers: CanvasLiveSyncHandlers): () => void {
    if (handlers.onMessage) this.messageListeners.add(handlers.onMessage);
    if (handlers.onStatus) {
      this.statusListeners.add(handlers.onStatus);
      handlers.onStatus(this.status);
    }
    return () => {
      if (handlers.onMessage) this.messageListeners.delete(handlers.onMessage);
      if (handlers.onStatus) this.statusListeners.delete(handlers.onStatus);
    };
  }

  /**
   * Open or re-open the live socket for one canvas. Does not replace subscribers.
   * Optional handlers are added as subscribers for backward compatibility.
   */
  start(
    canvasId: string,
    lastRevision: CanvasRevision,
    handlers: CanvasLiveSyncHandlers = {}
  ): void {
    if (this.disposed) {
      throw new CollaborationClientError({
        kind: "aborted",
        code: "collaboration_disposed",
        message: "CanvasLiveSyncClient has been disposed."
      });
    }
    if (!this.WebSocketImpl) {
      throw new CollaborationClientError({
        kind: "protocol",
        code: "collaboration_websocket_unavailable",
        message: "WebSocket implementation was not provided to CollaborationClient."
      });
    }
    const hello = canvasLiveSyncHelloSchema.parse({
      type: "canvas.live.hello",
      protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
      projectId: this.profile.projectId,
      canvasId,
      lastRevision
    });
    if (handlers.onMessage || handlers.onStatus) {
      this.subscribe(handlers);
    }
    if (
      this.wanted &&
      this.canvasId === hello.canvasId &&
      this.lastRevision === hello.lastRevision &&
      this.status.state !== "catchup_required" &&
      this.status.state !== "failed" &&
      this.status.state !== "stopped"
    ) {
      return;
    }
    this.stopConnection();
    this.generation += 1;
    this.canvasId = hello.canvasId;
    this.lastRevision = hello.lastRevision;
    this.wanted = true;
    this.reconnectAttempt = 0;
    this.connect(this.generation, hello.canvasId, hello.lastRevision);
  }

  /**
   * Advance the hello cursor by exactly one after a single live entry was applied.
   * Rejects non-contiguous jumps (catch-up must use acknowledgeMaterializedHead).
   */
  acknowledgeAppliedRevision(revision: CanvasRevision): void {
    if (this.lastRevision === null) {
      this.lastRevision = revision;
      return;
    }
    if (revision === this.lastRevision + 1) {
      this.lastRevision = revision;
      return;
    }
    if (revision === this.lastRevision) return;
    // Ignore non-contiguous or stale acks — HTTP recovery owns gap repair.
  }

  /**
   * Advance the hello cursor to a store head installed by authoritative HTTP recovery
   * (delta/snapshot catch-up). Allows monotone forward jumps (e.g. 1 → 5) without
   * requiring intermediate live frames.
   */
  acknowledgeMaterializedHead(revision: CanvasRevision): void {
    if (this.lastRevision === null || revision > this.lastRevision) {
      this.lastRevision = revision;
      return;
    }
    // Same or older head: ignore (never roll the cursor backwards).
  }

  /** Report catch-up recovery progress without taking over the socket. */
  reportCatchupRecovering(canvasId: string, attempt: number, delayMs: number): void {
    if (this.canvasId !== canvasId && this.wanted) return;
    this.setStatus({ state: "catchup_recovering", canvasId, attempt, delayMs });
  }

  stop(): void {
    this.wanted = false;
    this.generation += 1;
    this.stopConnection();
    this.canvasId = null;
    this.lastRevision = null;
    this.setStatus({ state: "stopped" });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.messageListeners.clear();
    this.statusListeners.clear();
    this.stop();
  }

  private stopConnection(): void {
    if (this.reconnectTimer) this.clock.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState !== 3) {
      try {
        socket.close(1000, "live sync stopped");
      } catch (error) {
        this.logger?.warn?.(
          redactCollaborationText(error instanceof Error ? error.message : "live sync close failed")
        );
      }
    }
  }

  private connect(generation: number, canvasId: string, lastRevision: CanvasRevision): void {
    if (!this.isScopeCurrent(generation, canvasId)) return;
    this.lastRevision = lastRevision;
    this.setStatus({ state: "connecting", canvasId, attempt: this.reconnectAttempt + 1 });
    void (async () => {
      try {
        const token = await this.credential.getDeviceToken();
        if (!this.isScopeCurrent(generation, canvasId)) return;
        if (!token) {
          this.wanted = false;
          this.setStatus({
            state: "auth_expired",
            canvasId,
            code: "collaboration_credential_missing"
          });
          return;
        }
        const base = new URL(this.profile.serverBaseUrl);
        const wsUrl = new URL(base.origin);
        wsUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";
        wsUrl.pathname =
          `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}` +
          `/canvases/${encodeURIComponent(canvasId)}/human/live`;
        const socket = new this.WebSocketImpl!(wsUrl.toString(), {
          headers: {
            Authorization: `Bearer ${token}`,
            Origin: derivedWebSocketOrigin(this.profile.serverBaseUrl)
          }
        });
        if (!this.isScopeCurrent(generation, canvasId)) {
          try {
            socket.close(1000, "stale live sync connection");
          } catch (error) {
            this.logger?.warn?.(
              redactCollaborationText(
                error instanceof Error ? error.message : "stale live sync close failed"
              )
            );
          }
          return;
        }
        this.socket = socket;
        const isCurrent = () => this.isScopeCurrent(generation, canvasId) && this.socket === socket;
        socket.addEventListener("open", () => {
          if (!isCurrent()) return;
          const helloRevision = this.lastRevision ?? lastRevision;
          socket.send(
            JSON.stringify(
              canvasLiveSyncHelloSchema.parse({
                type: "canvas.live.hello",
                protocolVersion: CANVAS_LIVE_SYNC_PROTOCOL_VERSION,
                projectId: this.profile.projectId,
                canvasId,
                lastRevision: helloRevision
              })
            )
          );
        });
        socket.addEventListener("message", (event: unknown) => {
          if (!isCurrent()) return;
          try {
            const text = textFromEvent(event);
            if (Buffer.byteLength(text, "utf8") > CANVAS_LIVE_SYNC_MAX_FRAME_BYTES) {
              throw new CollaborationClientError({
                kind: "payload_too_large",
                code: "collaboration_live_sync_payload_too_large",
                message: "Canvas live sync payload exceeded size limit."
              });
            }
            const message = canvasLiveSyncServerMessageSchema.parse(JSON.parse(text));
            const scope =
              message.type === "canvas.live.accepted_entry"
                ? {
                    projectId: message.entry.scope.projectId,
                    canvasId: message.entry.scope.canvasId
                  }
                : message.type === "canvas.live.pong"
                  ? null
                  : { projectId: message.projectId, canvasId: message.canvasId };
            if (
              scope &&
              (scope.projectId !== this.profile.projectId || scope.canvasId !== canvasId)
            ) {
              throw new CollaborationClientError({
                kind: "protocol",
                code: "collaboration_live_sync_scope_mismatch",
                message: "Canvas live sync payload scope did not match the active canvas."
              });
            }
            this.handleMessage(message, canvasId, isCurrent);
          } catch (error) {
            this.logger?.error?.(
              redactCollaborationText(
                error instanceof Error ? error.message : "live sync message failed"
              )
            );
            this.fail(canvasId, "collaboration_live_sync_protocol_error");
            try {
              socket.close(4000, "live sync protocol error");
            } catch (closeError) {
              this.logger?.warn?.(
                redactCollaborationText(
                  closeError instanceof Error ? closeError.message : "live sync close failed"
                )
              );
            }
          }
        });
        socket.addEventListener("close", (event: unknown) => {
          if (!isCurrent()) return;
          this.socket = undefined;
          const code =
            typeof event === "object" &&
            event !== null &&
            "code" in event &&
            typeof (event as { code: unknown }).code === "number"
              ? (event as { code: number }).code
              : 1006;
          if (!this.wanted || this.disposed) {
            return;
          }
          if (code === 4004) {
            // Stop the socket; catch-up recovery is owned by the replica facade with backoff.
            this.wanted = false;
            this.setStatus({ state: "catchup_required", canvasId });
            return;
          }
          if (
            this.status.state === "catchup_required" ||
            this.status.state === "catchup_recovering"
          ) {
            return;
          }
          if (code === 4001) {
            this.expireCredential(canvasId, "websocket_4001");
            return;
          }
          if (code === 4003) {
            this.denyAccess(canvasId, "websocket_4003");
            return;
          }
          if (code === 4000 || code === 4002 || code === 1009) {
            this.fail(canvasId, `websocket_${code}`);
            return;
          }
          if (code === 1000) {
            this.wanted = false;
            this.setStatus({ state: "stopped" });
            return;
          }
          this.scheduleReconnect(canvasId, generation);
        });
        socket.addEventListener("error", () => {
          if (isCurrent()) this.logger?.warn?.("collaboration live sync socket error");
        });
      } catch (error) {
        if (!this.isScopeCurrent(generation, canvasId)) return;
        this.logger?.error?.(
          redactCollaborationText(
            error instanceof Error ? error.message : "live sync connect failed"
          )
        );
        this.scheduleReconnect(canvasId, generation);
      }
    })();
  }

  private handleMessage(
    message: CanvasLiveSyncServerMessage,
    canvasId: string,
    isCurrent: () => boolean
  ): void {
    if (!isCurrent()) return;
    // Fan-out first so replica materialization can run before status side effects.
    for (const listener of [...this.messageListeners]) {
      try {
        listener(message);
      } catch (error) {
        this.logger?.error?.(
          redactCollaborationText(
            error instanceof Error ? error.message : "live sync listener failed"
          )
        );
      }
    }
    switch (message.type) {
      case "canvas.live.welcome":
        this.reconnectAttempt = 0;
        this.setStatus({ state: "connected", canvasId });
        break;
      case "canvas.live.accepted_entry":
        // Do NOT advance lastRevision here — only acknowledgeAppliedRevision after store apply.
        break;
      case "canvas.live.pong":
        break;
      case "canvas.live.catchup_required":
        this.wanted = false;
        this.setStatus({ state: "catchup_required", canvasId });
        break;
      case "canvas.live.auth_expired":
        if (message.code === "unauthorized") {
          this.expireCredential(canvasId, message.code);
        } else {
          this.denyAccess(canvasId, message.code);
        }
        break;
      case "canvas.live.error":
        if (message.code === "unauthorized") this.expireCredential(canvasId, message.code);
        else if (
          message.code === "forbidden" ||
          message.code === "unknown_canvas" ||
          message.code === "cross_scope"
        ) {
          this.denyAccess(canvasId, message.code);
        } else if (message.code !== "server_error") this.fail(canvasId, message.code);
        break;
      default: {
        const _exhaustive: never = message;
        void _exhaustive;
      }
    }
  }

  private scheduleReconnect(canvasId: string, generation: number): void {
    if (!this.isScopeCurrent(generation, canvasId)) return;
    this.reconnectAttempt += 1;
    const delayMs = reconnectDelay(this.reconnectAttempt, this.random, {
      initialDelayMs: this.reconnectInitialDelayMs,
      maxDelayMs: this.reconnectMaxDelayMs
    });
    this.setStatus({ state: "reconnecting", canvasId, attempt: this.reconnectAttempt, delayMs });
    if (this.reconnectTimer) this.clock.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect(generation, canvasId, this.lastRevision ?? 0);
    }, delayMs);
  }

  private expireCredential(canvasId: string, code: string): void {
    this.wanted = false;
    this.setStatus({ state: "auth_expired", canvasId, code });
  }

  private denyAccess(canvasId: string, code: string): void {
    this.wanted = false;
    this.setStatus({ state: "access_denied", canvasId, code });
  }

  private fail(canvasId: string, code: string): void {
    this.wanted = false;
    this.setStatus({ state: "failed", canvasId, code });
  }

  private isScopeCurrent(generation: number, canvasId: string): boolean {
    return (
      this.wanted && !this.disposed && generation === this.generation && this.canvasId === canvasId
    );
  }

  private setStatus(status: CanvasLiveSyncStatus): void {
    this.status = status;
    for (const listener of [...this.statusListeners]) {
      try {
        listener(status);
      } catch (error) {
        this.logger?.error?.(
          redactCollaborationText(
            error instanceof Error ? error.message : "live sync status listener failed"
          )
        );
      }
    }
  }
}
