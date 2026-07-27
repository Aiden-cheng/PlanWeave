import type {
  CanvasCommandAccepted,
  CanvasCommandOutcome,
  CanvasContentDigest,
  CanvasJournalEntry,
  CanvasReconnectResponse,
  CanvasRevision
} from "@planweave-ai/collaboration-contracts";

/**
 * Client-side durable canvas command session state.
 * Tracks only server-authoritative revision/operation metadata — never presence.
 */
export type CanvasCommandSessionSnapshot = {
  readonly canvasId: string;
  readonly revision: CanvasRevision;
  readonly contentDigest: CanvasContentDigest | null;
  readonly lastOperationId: string | null;
  readonly lastJournalEntryId: string | null;
  readonly pendingOperationId: string | null;
  readonly lastConflict: {
    readonly expectedRevision: CanvasRevision;
    readonly authoritativeRevision: CanvasRevision;
    readonly authoritativeContentDigest: CanvasContentDigest;
  } | null;
  readonly lastRejectCode: string | null;
};

export class CanvasCommandSessionState {
  private canvasId: string | null = null;
  private revision: CanvasRevision = 0;
  private contentDigest: CanvasContentDigest | null = null;
  private lastOperationId: string | null = null;
  private lastJournalEntryId: string | null = null;
  private pendingOperationId: string | null = null;
  private lastConflict: CanvasCommandSessionSnapshot["lastConflict"] = null;
  private lastRejectCode: string | null = null;
  /** operationIds already acknowledged (accepted, including idempotent replay). */
  private readonly appliedOperationIds = new Set<string>();

  bind(canvasId: string): void {
    if (this.canvasId === canvasId) return;
    this.reset(canvasId);
  }

  clear(): void {
    this.reset(null);
  }

  snapshot(): CanvasCommandSessionSnapshot | null {
    if (this.canvasId === null) return null;
    return {
      canvasId: this.canvasId,
      revision: this.revision,
      contentDigest: this.contentDigest,
      lastOperationId: this.lastOperationId,
      lastJournalEntryId: this.lastJournalEntryId,
      pendingOperationId: this.pendingOperationId,
      lastConflict: this.lastConflict,
      lastRejectCode: this.lastRejectCode
    };
  }

  getRevision(): CanvasRevision {
    return this.revision;
  }

  getContentDigest(): CanvasContentDigest | null {
    return this.contentDigest;
  }

  getCanvasId(): string | null {
    return this.canvasId;
  }

  beginSubmit(operationId: string): void {
    this.pendingOperationId = operationId;
    this.lastRejectCode = null;
    this.lastConflict = null;
  }

  applyOutcome(outcome: CanvasCommandOutcome): void {
    if (outcome.type === "canvas.command.accepted") {
      this.applyAccepted(outcome);
      return;
    }
    this.pendingOperationId = null;
    this.lastRejectCode = outcome.code;
    this.lastOperationId = outcome.operationId;
    if (outcome.code === "stale_revision" && outcome.conflict) {
      this.lastConflict = {
        expectedRevision: outcome.conflict.expectedRevision,
        authoritativeRevision: outcome.conflict.authoritativeRevision,
        authoritativeContentDigest: outcome.conflict.authoritativeContentDigest
      };
      // Surface authoritative head without guessing a merge or auto-rewriting expectedRevision.
      this.revision = outcome.conflict.authoritativeRevision;
      this.contentDigest = outcome.conflict.authoritativeContentDigest;
    }
  }

  applyAccepted(accepted: CanvasCommandAccepted): void {
    this.revision = accepted.revision;
    this.contentDigest = accepted.contentDigest;
    this.lastOperationId = accepted.operationId;
    this.lastJournalEntryId = accepted.journalEntryId;
    this.pendingOperationId = null;
    this.lastConflict = null;
    this.lastRejectCode = null;
    this.appliedOperationIds.add(accepted.operationId);
  }

  /**
   * Advance session from a server reconnect response.
   * Returns journal entries that the client has not yet applied locally (for Runtime apply).
   */
  applyReconnect(response: CanvasReconnectResponse): {
    entriesToApply: CanvasJournalEntry[];
    snapshotRequired: boolean;
  } {
    if (response.type === "canvas.reconnect.error") {
      this.lastRejectCode = response.code;
      return { entriesToApply: [], snapshotRequired: false };
    }
    if (response.type === "canvas.reconnect.snapshot") {
      this.revision = response.snapshot.metadata.revision;
      this.contentDigest = response.snapshot.metadata.contentDigest;
      this.lastConflict = null;
      this.lastRejectCode = null;
      this.pendingOperationId = null;
      return { entriesToApply: [], snapshotRequired: true };
    }
    // delta
    const entriesToApply: CanvasJournalEntry[] = [];
    for (const entry of response.entries) {
      if (!this.appliedOperationIds.has(entry.operationId)) {
        entriesToApply.push(entry);
        this.appliedOperationIds.add(entry.operationId);
      }
      this.revision = entry.revision;
      this.contentDigest = entry.contentDigest;
      this.lastOperationId = entry.operationId;
      this.lastJournalEntryId = entry.entryId;
    }
    if (response.entries.length === 0) {
      this.revision = response.headRevision;
      this.contentDigest = response.headContentDigest;
    } else {
      this.revision = response.headRevision;
      this.contentDigest = response.headContentDigest;
    }
    this.lastConflict = null;
    this.lastRejectCode = null;
    this.pendingOperationId = null;
    return { entriesToApply, snapshotRequired: false };
  }

  hasApplied(operationId: string): boolean {
    return this.appliedOperationIds.has(operationId);
  }

  private reset(canvasId: string | null): void {
    this.canvasId = canvasId;
    this.revision = 0;
    this.contentDigest = null;
    this.lastOperationId = null;
    this.lastJournalEntryId = null;
    this.pendingOperationId = null;
    this.lastConflict = null;
    this.lastRejectCode = null;
    this.appliedOperationIds.clear();
  }
}
