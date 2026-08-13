import type { CollaborationMutationRecord } from "../../shared/collaborationReadModels.js";

/**
 * Private, connection-local disorder/retry windows. They bound renderer memory only and do not
 * negotiate or make assumptions about Server observer retention.
 */
const APPLIED_EVENT_CURSOR_WINDOW = 512;
const FAILED_EVENT_CURSOR_WINDOW = 128;
const TERMINAL_MUTATION_WINDOW = 256;

export class CollaborationEventCursorWindow {
  private readonly applied = new Set<number>();
  private readonly inFlight = new Map<number, number>();
  private readonly failed = new Set<number>();
  private refreshRequired = false;
  private invalidationVersion = 0;

  hasApplied(cursor: number): boolean {
    return this.applied.has(cursor);
  }

  isInFlight(cursor: number): boolean {
    return this.inFlight.has(cursor);
  }

  isFailed(cursor: number): boolean {
    return this.failed.has(cursor);
  }

  requiresRefresh(): boolean {
    return this.refreshRequired;
  }

  requestRefresh(): void {
    this.requireRefresh();
  }

  version(): number {
    return this.invalidationVersion;
  }

  begin(cursor: number, attemptToken: number): void {
    this.inFlight.set(cursor, attemptToken);
  }

  finish(cursor: number, attemptToken: number): void {
    if (this.inFlight.get(cursor) === attemptToken) {
      this.inFlight.delete(cursor);
    }
  }

  markApplied(cursor: number): void {
    if (!this.applied.has(cursor) && this.applied.size < APPLIED_EVENT_CURSOR_WINDOW) {
      this.applied.add(cursor);
    }
    this.failed.delete(cursor);
    if (this.applied.size >= APPLIED_EVENT_CURSOR_WINDOW) {
      this.requireRefresh();
    }
  }

  markFailed(cursor: number): void {
    this.invalidationVersion += 1;
    if (this.failed.size < FAILED_EVENT_CURSOR_WINDOW) {
      this.failed.add(cursor);
    }
    if (this.failed.size >= FAILED_EVENT_CURSOR_WINDOW) {
      this.requireRefresh();
    }
  }

  resetForCatchup(): void {
    this.applied.clear();
    this.inFlight.clear();
    this.failed.clear();
    this.refreshRequired = false;
    this.invalidationVersion += 1;
  }

  retireAfterRefresh(expectedVersion: number): boolean {
    if (expectedVersion !== this.invalidationVersion) return false;
    this.applied.clear();
    this.failed.clear();
    this.refreshRequired = false;
    return true;
  }

  private requireRefresh(): void {
    this.refreshRequired = true;
    this.invalidationVersion += 1;
  }
}

export class CollaborationMutationLedger {
  readonly records = new Map<string, CollaborationMutationRecord>();
  private readonly terminalMutationIds: string[] = [];

  setPending(record: CollaborationMutationRecord): void {
    this.records.set(record.mutationId, record);
  }

  setTerminal(record: CollaborationMutationRecord): void {
    this.records.set(record.mutationId, record);
    this.terminalMutationIds.push(record.mutationId);
    while (this.terminalMutationIds.length > TERMINAL_MUTATION_WINDOW) {
      const retiredMutationId = this.terminalMutationIds.shift();
      if (retiredMutationId === undefined) continue;
      const mutation = this.records.get(retiredMutationId);
      if (mutation && mutation.status !== "pending") {
        this.records.delete(retiredMutationId);
      }
    }
  }
}
