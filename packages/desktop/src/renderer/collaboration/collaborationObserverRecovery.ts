import { CollaborationEventCursorWindow } from "./collaborationRetention.js";

type RefreshHandle = {
  completion: Promise<void>;
  requestId: number;
};

type RecoveryRequest = {
  eventCursors: CollaborationEventCursorWindow;
  isCurrent(): boolean;
  refresh(): RefreshHandle;
  wasSuccessful(requestId: number): boolean;
  onError(error: unknown): void;
  onRetired(): void;
};

export class CollaborationObserverRecovery {
  private active: Promise<void> | null = null;

  clear(): void {
    this.active = null;
  }

  schedule(request: RecoveryRequest): void {
    if (!request.eventCursors.requiresRefresh() || this.active || !request.isCurrent()) return;

    const invalidationVersion = request.eventCursors.version();
    const refresh = request.refresh();
    let recovery!: Promise<void>;
    recovery = refresh.completion
      .catch((error: unknown) => {
        if (request.isCurrent()) request.onError(error);
      })
      .finally(() => {
        if (
          request.isCurrent() &&
          request.wasSuccessful(refresh.requestId) &&
          request.eventCursors.retireAfterRefresh(invalidationVersion)
        ) {
          request.onRetired();
        }
        if (this.active === recovery) this.active = null;
        if (
          request.isCurrent() &&
          request.eventCursors.requiresRefresh() &&
          invalidationVersion !== request.eventCursors.version()
        ) {
          this.schedule(request);
        }
      });
    this.active = recovery;
  }
}
