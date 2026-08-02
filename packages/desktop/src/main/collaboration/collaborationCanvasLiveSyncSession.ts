import {
  collaborationCanvasLiveSyncInputSchema,
  type CollaborationCanvasLiveSyncSignal
} from "../../shared/collaboration.js";
import type { CollaborationClient } from "./CollaborationClient.js";
import { CollaborationClientError } from "./collaborationErrors.js";
import type { ResolvedCollaborationCanvasBinding } from "./ContentVersionFacade.js";
import type { CanvasLiveSyncHandlers } from "./CanvasLiveSyncClient.js";

export type CollaborationCanvasLiveSyncClientPort = Pick<
  CollaborationClient,
  | "projectId"
  | "canvasCommandSession"
  | "liveSyncCanvas"
  | "liveSyncHelloRevision"
  | "liveSyncState"
  | "startLiveSync"
  | "stopLiveSync"
  | "subscribeLiveSync"
>;

export type CollaborationCanvasLiveSyncSessionHost = {
  getClient(): CollaborationCanvasLiveSyncClientPort | null;
  getClientProfileId(): string | null;
  resolveCanvasBinding(input: {
    localProjectId: string;
    canvasId: string;
  }): Promise<ResolvedCollaborationCanvasBinding | null>;
  publishCanvasLiveSyncSignal(signal: CollaborationCanvasLiveSyncSignal): void;
  clearDeviceCredential(profileId: string): Promise<void>;
  publishStatus(): Promise<unknown>;
};

/**
 * Renderer-facing live-sync session: attaches signal subscribers only.
 * It never owns exclusive handlers. Command-facade bind owns socket start and replica apply.
 * When live is not yet open for the canvas, this session may open the connection at the
 * command-session revision, then subscribe — replica apply still attaches separately via facade.
 */
export class CollaborationCanvasLiveSyncSession {
  private scope: {
    localProjectId: string;
    localCanvasId: string;
    remoteProjectId: string;
    remoteCanvasId: string;
  } | null = null;
  private generation = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly host: CollaborationCanvasLiveSyncSessionHost) {}

  reset(): void {
    this.generation += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.scope = null;
  }

  async start(input: unknown): Promise<void> {
    const parsed = collaborationCanvasLiveSyncInputSchema.parse(input);
    const client = this.host.getClient();
    const profileId = this.host.getClientProfileId();
    if (!client || !profileId) {
      throw new CollaborationClientError({
        kind: "aborted",
        code: "collaboration_session_not_connected",
        message: "Collaboration session is not connected."
      });
    }
    const resolved = await this.host.resolveCanvasBinding(parsed);
    const commandSession = client.canvasCommandSession();
    if (
      !resolved ||
      resolved.localProjectId !== parsed.localProjectId ||
      resolved.localCanvasId !== parsed.canvasId ||
      resolved.remoteProjectId !== client.projectId ||
      !commandSession ||
      commandSession.canvasId !== resolved.remoteCanvasId
    ) {
      throw new CollaborationClientError({
        kind: "aborted",
        code: "collaboration_canvas_live_sync_session_required",
        message: "The Canvas command session must be bound to the requested remote canvas.",
        retryable: false
      });
    }
    const nextScope = {
      localProjectId: resolved.localProjectId,
      localCanvasId: resolved.localCanvasId,
      remoteProjectId: resolved.remoteProjectId,
      remoteCanvasId: resolved.remoteCanvasId
    };
    this.generation += 1;
    const generation = this.generation;
    this.scope = nextScope;
    this.unsubscribe?.();
    this.unsubscribe = null;

    const isCurrent = () =>
      this.generation === generation &&
      this.scope === nextScope &&
      this.host.getClient() === client &&
      this.host.getClientProfileId() === profileId;

    const handlers: CanvasLiveSyncHandlers = {
      onMessage: (message) => {
        if (!isCurrent()) return;
        this.host.publishCanvasLiveSyncSignal({
          profileId,
          projectId: nextScope.remoteProjectId,
          canvasId: nextScope.remoteCanvasId,
          message
        });
      },
      onStatus: (status) => {
        if (!isCurrent()) return;
        if (status.state !== "auth_expired") return;
        this.generation += 1;
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.scope = null;
        // Do not stopLiveSync here — command facade owns the socket. Only clear credentials.
        void this.host.clearDeviceCredential(profileId).then(() => this.host.publishStatus());
      }
    };

    // Prefer subscribe-only when the command facade already owns the live socket for this canvas.
    if (
      client.liveSyncCanvas() === nextScope.remoteCanvasId &&
      typeof client.subscribeLiveSync === "function"
    ) {
      this.unsubscribe = client.subscribeLiveSync(handlers);
      return;
    }

    // Passive open: establish connection without exclusive handler ownership.
    // Handlers are attached via subscribe so a later command-facade start keeps apply handlers.
    if (typeof client.subscribeLiveSync === "function") {
      this.unsubscribe = client.subscribeLiveSync(handlers);
    }
    client.startLiveSync(
      nextScope.remoteCanvasId,
      commandSession.revision,
      typeof client.subscribeLiveSync === "function" ? {} : handlers
    );
  }

  stop(): void {
    this.generation += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.scope = null;
    // Never stopLiveSync — command facade is the socket owner. Detaching signal listeners is enough.
  }
}
