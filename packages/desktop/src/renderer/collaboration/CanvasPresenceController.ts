import type {
  CanvasPresencePointer,
  CanvasPresenceServerMessage,
  CanvasPresenceSession
} from "@planweave-ai/collaboration-contracts";
import type {
  CollaborationPresenceSignal,
  CollaborationPresenceUpdateInput,
  PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";

const MAX_REMOTE_SESSIONS = 32;
const MAX_SELECTION_IDS = 32;
const MAX_DISPLAY_NAME_LENGTH = 64;
const MAX_SELECTION_ID_LENGTH = 128;

export type CanvasPresenceBridge = Pick<
  PlanWeaveCollaborationApi,
  | "startCollaborationPresence"
  | "stopCollaborationPresence"
  | "publishCollaborationPresence"
  | "onCollaborationPresenceSignal"
>;

export type CanvasPresenceRemoteSession = {
  sessionId: string;
  humanPrincipalId: string;
  displayName: string;
  pointer: CanvasPresencePointer | null;
  selectionIds: string[];
};

export type CanvasPresenceSnapshot = {
  sessions: CanvasPresenceRemoteSession[];
  error: string | null;
};

export type CanvasPresenceScope = {
  profileId: string;
  canvasId: string;
};

type TrackedSession = CanvasPresenceRemoteSession;

const EMPTY_SNAPSHOT: CanvasPresenceSnapshot = { sessions: [], error: null };

function cleanText(value: unknown, maxLength: number, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value
    .normalize("NFKC")
    .replace(/\p{Cc}/gu, "")
    .trim()
    .slice(0, maxLength);
  return cleaned || fallback;
}

function cleanPointer(value: unknown): CanvasPresencePointer | null {
  if (!value || typeof value !== "object") return null;
  const pointer = value as { x?: unknown; y?: unknown };
  if (
    typeof pointer.x !== "number" ||
    typeof pointer.y !== "number" ||
    !Number.isFinite(pointer.x) ||
    !Number.isFinite(pointer.y) ||
    Math.abs(pointer.x) > 1_000_000 ||
    Math.abs(pointer.y) > 1_000_000
  ) {
    return null;
  }
  return { x: pointer.x, y: pointer.y };
}

function cleanSelectionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const id = cleanText(item, MAX_SELECTION_ID_LENGTH, "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_SELECTION_IDS) break;
  }
  return ids;
}

function sanitizeSession(session: CanvasPresenceSession): CanvasPresenceRemoteSession {
  return {
    sessionId: cleanText(session.identity.sessionId, MAX_SELECTION_ID_LENGTH, "unknown-session"),
    humanPrincipalId: cleanText(
      session.identity.humanPrincipalId,
      MAX_SELECTION_ID_LENGTH,
      "unknown-member"
    ),
    displayName: cleanText(session.identity.displayName, MAX_DISPLAY_NAME_LENGTH, "Collaborator"),
    pointer: cleanPointer(session.pointer),
    selectionIds: cleanSelectionIds(session.selectionIds)
  };
}

function sameScope(message: CanvasPresenceServerMessage, scope: CanvasPresenceScope): boolean {
  return message.canvasId === scope.canvasId;
}

function toErrorMessage(
  message: Extract<CanvasPresenceServerMessage, { type: "canvas.presence.error" }>
): string {
  return `Canvas presence error: ${message.code}`;
}

/** Renderer read model for one ephemeral canvas presence scope. */
export class CanvasPresenceController {
  private readonly api: CanvasPresenceBridge;
  private scope: CanvasPresenceScope | null = null;
  private sessions = new Map<string, TrackedSession>();
  private listeners = new Set<(snapshot: CanvasPresenceSnapshot) => void>();
  private unsubscribeSignal: (() => void) | null = null;
  private generation = 0;
  private snapshot: CanvasPresenceSnapshot = EMPTY_SNAPSHOT;

  constructor(options: { api: CanvasPresenceBridge }) {
    this.api = options.api;
  }

  getSnapshot(): CanvasPresenceSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: CanvasPresenceSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(scope: CanvasPresenceScope): Promise<void> {
    if (this.scope?.profileId === scope.profileId && this.scope.canvasId === scope.canvasId) {
      return;
    }
    await this.stop();
    const generation = ++this.generation;
    this.scope = { ...scope };
    this.unsubscribeSignal = this.api.onCollaborationPresenceSignal((signal) => {
      if (generation !== this.generation) return;
      this.handleSignal(signal);
    });
    try {
      await this.api.startCollaborationPresence({ canvasId: scope.canvasId });
    } catch (error) {
      if (generation !== this.generation) return;
      this.publishSnapshot({
        sessions: [],
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.scope = null;
    this.unsubscribeSignal?.();
    this.unsubscribeSignal = null;
    this.sessions.clear();
    this.publishSnapshot(EMPTY_SNAPSHOT);
    try {
      await this.api.stopCollaborationPresence();
    } catch {
      // Main process may already have stopped the socket during disconnect.
    }
  }

  async publish(input: CollaborationPresenceUpdateInput): Promise<void> {
    await this.api.publishCollaborationPresence({
      pointer: cleanPointer(input.pointer),
      selectionIds: cleanSelectionIds(input.selectionIds)
    });
  }

  private handleSignal(signal: CollaborationPresenceSignal): void {
    const scope = this.scope;
    if (!scope || signal.profileId !== scope.profileId) return;
    const message = signal.message;
    if (!sameScope(message, scope)) return;
    switch (message.type) {
      case "canvas.presence.snapshot": {
        this.sessions.clear();
        for (const session of message.sessions) this.upsertSession(session);
        this.publishSnapshot({ sessions: this.readSessions(), error: null });
        return;
      }
      case "canvas.presence.update":
        this.upsertSession(message.session);
        this.publishSnapshot({ sessions: this.readSessions(), error: null });
        return;
      case "canvas.presence.leave":
        this.sessions.delete(message.sessionId);
        this.publishSnapshot({ sessions: this.readSessions(), error: null });
        return;
      case "canvas.presence.error":
        this.sessions.clear();
        this.publishSnapshot({ sessions: [], error: toErrorMessage(message) });
        return;
      default: {
        const _exhaustive: never = message;
        void _exhaustive;
      }
    }
  }

  private upsertSession(session: CanvasPresenceSession): void {
    const scope = this.scope;
    if (!scope) return;
    const sanitized = sanitizeSession(session);
    if (!this.sessions.has(sanitized.sessionId) && this.sessions.size >= MAX_REMOTE_SESSIONS) {
      return;
    }
    this.sessions.set(sanitized.sessionId, sanitized);
  }

  private readSessions(): CanvasPresenceRemoteSession[] {
    return [...this.sessions.values()];
  }

  private publishSnapshot(next: CanvasPresenceSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener(next);
  }
}
