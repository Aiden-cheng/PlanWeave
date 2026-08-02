import {
  collaborationCanvasLiveSyncInputSchema,
  type CollaborationCanvasLiveSyncSignal
} from "../../shared/collaboration.js";
import type { CollaborationClient } from "./CollaborationClient.js";
import { CollaborationClientError } from "./collaborationErrors.js";
import type { ResolvedCollaborationCanvasBinding } from "./ContentVersionFacade.js";

export type CollaborationCanvasLiveSyncClientPort = Pick<
  CollaborationClient,
  | "projectId"
  | "canvasCommandSession"
  | "liveSyncCanvas"
  | "liveSyncHelloRevision"
  | "liveSyncState"
  | "startLiveSync"
  | "stopLiveSync"
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
 * Service-scoped bridge between opaque local canvas identity and a single remote live socket.
 * It never materializes journal entries; HTTP reconnect remains the only recovery mechanism.
 */
export class CollaborationCanvasLiveSyncSession {
  private scope: {
    localProjectId: string;
    localCanvasId: string;
    remoteProjectId: string;
    remoteCanvasId: string;
  } | null = null;
  private generation = 0;

  constructor(private readonly host: CollaborationCanvasLiveSyncSessionHost) {}

  reset(): void {
    this.generation += 1;
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
    if (
      this.scope?.localProjectId === nextScope.localProjectId &&
      this.scope.localCanvasId === nextScope.localCanvasId &&
      this.scope.remoteProjectId === nextScope.remoteProjectId &&
      this.scope.remoteCanvasId === nextScope.remoteCanvasId &&
      client.liveSyncCanvas() === nextScope.remoteCanvasId &&
      client.liveSyncHelloRevision() === commandSession.revision &&
      client.liveSyncState().state !== "catchup_required" &&
      client.liveSyncState().state !== "failed" &&
      client.liveSyncState().state !== "auth_expired" &&
      client.liveSyncState().state !== "access_denied" &&
      client.liveSyncState().state !== "stopped"
    ) {
      return;
    }
    this.generation += 1;
    const generation = this.generation;
    this.scope = nextScope;
    const isCurrent = () =>
      this.generation === generation &&
      this.scope === nextScope &&
      this.host.getClient() === client &&
      this.host.getClientProfileId() === profileId;
    client.startLiveSync(nextScope.remoteCanvasId, commandSession.revision, {
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
        this.scope = null;
        client.stopLiveSync();
        void this.host.clearDeviceCredential(profileId).then(() => this.host.publishStatus());
      }
    });
  }

  stop(): void {
    this.generation += 1;
    this.scope = null;
    this.host.getClient()?.stopLiveSync();
  }
}
