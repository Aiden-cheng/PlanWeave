import {
  collaborationPresenceCanvasInputSchema,
  collaborationPresenceUpdateInputSchema,
  type CollaborationPresenceSignal,
  type CollaborationPresenceUpdateInput
} from "../../shared/collaboration.js";
import type { CollaborationClient, CollaborationPresenceStatus } from "./CollaborationClient.js";
import { CollaborationClientError } from "./collaborationErrors.js";

export type CollaborationPresenceSessionHost = {
  getClient(): CollaborationClient | null;
  getClientProfileId(): string | null;
  publishPresenceSignal(signal: CollaborationPresenceSignal): void;
  setSessionError(detail: string, error: { code: string; message: string }): void;
  clearDeviceCredential(profileId: string): Promise<void>;
  publishStatus(): Promise<unknown>;
};

/**
 * Ephemeral canvas presence session state for CollaborationService.
 * Independent from durable canvas command revision tracking.
 */
export class CollaborationPresenceSession {
  private presenceCanvasId: string | null = null;
  private presenceGeneration = 0;
  /** Last local pointer/selection; re-published after each successful snapshot (reconnect). */
  private lastUpdate: CollaborationPresenceUpdateInput | null = null;

  constructor(private readonly host: CollaborationPresenceSessionHost) {}

  reset(): void {
    this.presenceGeneration += 1;
    this.presenceCanvasId = null;
    this.lastUpdate = null;
  }

  canvasId(): string | null {
    return this.presenceCanvasId;
  }

  async start(input: unknown): Promise<void> {
    const { canvasId } = collaborationPresenceCanvasInputSchema.parse(input);
    const client = this.host.getClient();
    const profileId = this.host.getClientProfileId();
    if (!client || !profileId) {
      throw new CollaborationClientError({
        kind: "aborted",
        code: "collaboration_session_not_connected",
        message: "Collaboration session is not connected."
      });
    }
    if (this.presenceCanvasId === canvasId && client.presenceCanvas() === canvasId) return;
    // Canvas change drops the previous surface's pointer; same-canvas reconnect keeps lastUpdate.
    if (this.presenceCanvasId !== canvasId) {
      this.lastUpdate = null;
    }
    this.presenceGeneration += 1;
    const generation = this.presenceGeneration;
    this.presenceCanvasId = canvasId;
    const isCurrent = () =>
      this.host.getClient() === client &&
      this.host.getClientProfileId() === profileId &&
      this.presenceCanvasId === canvasId &&
      this.presenceGeneration === generation;
    client.startPresence(canvasId, {
      onSnapshot: (message) => {
        if (!isCurrent()) return;
        this.host.publishPresenceSignal({ profileId, message });
        // Server-accepted reconnect: re-announce last local cursor without requiring a UI gesture.
        this.republishLastUpdate(client, isCurrent);
      },
      onUpdate: (message) => {
        if (!isCurrent()) return;
        this.host.publishPresenceSignal({ profileId, message });
      },
      onLeave: (message) => {
        if (!isCurrent()) return;
        this.host.publishPresenceSignal({ profileId, message });
      },
      onError: (message) => {
        if (!isCurrent()) return;
        this.host.publishPresenceSignal({ profileId, message });
      },
      onStatus: (status: CollaborationPresenceStatus) => {
        if (!isCurrent()) return;
        if (status.state === "reconnecting") {
          this.host.publishPresenceSignal({
            profileId,
            reset: { canvasId, reason: "disconnected" }
          });
        } else if (status.state === "auth_expired") {
          this.host.publishPresenceSignal({
            profileId,
            reset: { canvasId, reason: "auth_expired" }
          });
        } else if (status.state === "error") {
          this.host.publishPresenceSignal({ profileId, reset: { canvasId, reason: "error" } });
        }
        if (status.state === "auth_expired") {
          this.presenceCanvasId = null;
          this.lastUpdate = null;
          this.presenceGeneration += 1;
          try {
            client.stopPresence();
          } catch {
            // ignore close races during auth invalidation
          }
          this.host.setSessionError("presence:auth_expired", {
            code: status.code,
            message: "Collaboration device credential was rejected by the server."
          });
          void this.host.clearDeviceCredential(profileId).then(() => this.host.publishStatus());
        } else if (status.state === "error") {
          this.host.setSessionError(`presence:${status.state}`, {
            code: status.code,
            message: status.code
          });
          void this.host.publishStatus();
        }
      }
    });
  }

  async stop(): Promise<void> {
    this.presenceGeneration += 1;
    this.presenceCanvasId = null;
    this.lastUpdate = null;
    try {
      this.host.getClient()?.stopPresence();
    } catch {
      // ignore close races during scope teardown
    }
  }

  async publish(input: unknown): Promise<void> {
    const parsed = collaborationPresenceUpdateInputSchema.parse(input);
    const client = this.host.getClient();
    if (!client || !this.host.getClientProfileId() || !this.presenceCanvasId) {
      throw new CollaborationClientError({
        kind: "aborted",
        code: "collaboration_presence_not_connected",
        message: "Canvas presence is not connected."
      });
    }
    this.lastUpdate = {
      pointer: parsed.pointer,
      selectionIds: [...parsed.selectionIds]
    };
    client.publishPresence(parsed);
  }

  private republishLastUpdate(client: CollaborationClient, isCurrent: () => boolean): void {
    const pending = this.lastUpdate;
    if (!pending || !isCurrent()) return;
    try {
      client.publishPresence(pending);
    } catch {
      // Socket may still be settling; renderer controller also flushes pending updates.
    }
  }
}
