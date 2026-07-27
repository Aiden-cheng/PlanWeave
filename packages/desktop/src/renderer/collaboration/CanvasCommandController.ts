import type {
  CanvasCommandIntent,
  CanvasCommandOperationId
} from "@planweave-ai/collaboration-contracts";
import type {
  CollaborationCanvasCommandSessionView,
  CollaborationCanvasCommandSubmitResult,
  CollaborationCanvasReconnectResult,
  PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";

export type CanvasCommandBridge = Pick<
  PlanWeaveCollaborationApi,
  | "submitCollaborationCanvasCommand"
  | "reconnectCollaborationCanvas"
  | "bindCollaborationCanvasCommandSession"
  | "getCollaborationCanvasCommandSession"
>;

export type CanvasCommandControllerSnapshot = {
  session: CollaborationCanvasCommandSessionView | null;
  lastError: string | null;
  lastStaleConflict: CollaborationCanvasCommandSessionView["lastConflict"] | null;
  busy: boolean;
};

export type CanvasCommandLabels = {
  staleRevision: (expected: number, authoritative: number) => string;
  rejected: (code: string) => string;
  reconnectFailed: (code: string) => string;
  notConnected: string;
};

const EMPTY: CanvasCommandControllerSnapshot = {
  session: null,
  lastError: null,
  lastStaleConflict: null,
  busy: false
};

/**
 * Renderer controller for shared-mode durable canvas mutations.
 * Submits typed intents only; never writes package files directly.
 * CAS conflicts are surfaced without guessing a merged revision.
 */
export class CanvasCommandController {
  private readonly api: CanvasCommandBridge;
  private readonly labels: CanvasCommandLabels;
  private snapshot: CanvasCommandControllerSnapshot = EMPTY;
  private readonly listeners = new Set<(snapshot: CanvasCommandControllerSnapshot) => void>();
  private canvasId: string | null = null;
  private generation = 0;

  constructor(options: { api: CanvasCommandBridge; labels: CanvasCommandLabels }) {
    this.api = options.api;
    this.labels = options.labels;
  }

  subscribe(listener: (snapshot: CanvasCommandControllerSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): CanvasCommandControllerSnapshot {
    return this.snapshot;
  }

  async bind(canvasId: string): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    this.canvasId = canvasId;
    this.patch({ busy: true, lastError: null, lastStaleConflict: null });
    try {
      const session = await this.api.bindCollaborationCanvasCommandSession({ canvasId });
      if (generation !== this.generation) return;
      this.patch({ session, busy: false });
      // Align with server head via reconnect (delta or full snapshot).
      await this.reconnect({ canvasId });
    } catch (error) {
      if (generation !== this.generation) return;
      this.patch({
        busy: false,
        lastError: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async unbind(): Promise<void> {
    this.generation += 1;
    this.canvasId = null;
    this.patch({ ...EMPTY });
  }

  /**
   * Submit a typed intent. On acceptance, session revision advances.
   * On stale_revision, surfaces conflict and does not invent a retry revision.
   */
  async submit(input: {
    intent: CanvasCommandIntent;
    operationId?: CanvasCommandOperationId | string;
    expectedRevision?: number;
  }): Promise<CollaborationCanvasCommandSubmitResult> {
    const canvasId = this.canvasId;
    if (!canvasId) {
      throw new Error(this.labels.notConnected);
    }
    this.patch({ busy: true, lastError: null, lastStaleConflict: null });
    try {
      const result = await this.api.submitCollaborationCanvasCommand({
        canvasId,
        intent: input.intent,
        ...(input.operationId !== undefined
          ? { operationId: input.operationId as CanvasCommandOperationId }
          : {}),
        expectedRevision: input.expectedRevision
      });
      if (result.outcome.type === "canvas.command.rejected") {
        if (result.outcome.code === "stale_revision" && result.outcome.conflict) {
          this.patch({
            session: result.session,
            busy: false,
            lastStaleConflict: result.outcome.conflict,
            lastError: this.labels.staleRevision(
              result.outcome.conflict.expectedRevision,
              result.outcome.conflict.authoritativeRevision
            )
          });
        } else {
          this.patch({
            session: result.session,
            busy: false,
            lastError: this.labels.rejected(result.outcome.code)
          });
        }
      } else {
        this.patch({ session: result.session, busy: false, lastError: null, lastStaleConflict: null });
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.patch({ busy: false, lastError: message });
      throw error;
    }
  }

  async reconnect(input?: {
    canvasId?: string;
    afterRevision?: number;
    afterContentDigest?: string;
  }): Promise<CollaborationCanvasReconnectResult> {
    const canvasId = input?.canvasId ?? this.canvasId;
    if (!canvasId) {
      throw new Error(this.labels.notConnected);
    }
    this.canvasId = canvasId;
    this.patch({ busy: true, lastError: null });
    try {
      const result = await this.api.reconnectCollaborationCanvas({
        canvasId,
        afterRevision: input?.afterRevision,
        afterContentDigest: input?.afterContentDigest
      });
      if (result.response.type === "canvas.reconnect.error") {
        this.patch({
          session: result.session,
          busy: false,
          lastError: this.labels.reconnectFailed(result.response.code)
        });
      } else {
        this.patch({
          session: result.session,
          busy: false,
          lastError: null,
          lastStaleConflict: null
        });
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.patch({ busy: false, lastError: message });
      throw error;
    }
  }

  private patch(partial: Partial<CanvasCommandControllerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    for (const listener of this.listeners) listener(this.snapshot);
  }
}
