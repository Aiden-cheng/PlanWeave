import type {
  AssignmentDisplayProjection,
  CommentDisplayProjection,
  HumanObserverEvent,
  WorkItemRef
} from "@planweave-ai/collaboration-contracts";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import {
  workItemKey,
  type CollaborationActivityListQueryInput,
  type CollaborationAssignmentListQueryInput,
  type CollaborationAssignmentUpdateInput,
  type CollaborationBoundaryErrorView,
  type CollaborationCommentCreateInput,
  type CollaborationCommentEditInput,
  type CollaborationCommentListQueryInput,
  type CollaborationCommentTombstoneInput,
  type CollaborationHostProjection,
  type CollaborationMutationRecord,
  type CollaborationObserverSignal,
  type CollaborationReadModelSnapshot,
  type CollaborationRemoteRunProjection,
  type CollaborationRemoteRunStatus,
  type CollaborationSyncPhase,
  type HumanMembershipView
} from "../../shared/collaborationReadModels.js";

export type CollaborationReadBridgePort = Pick<
  PlanWeaveCollaborationApi,
  | "getCollaborationStatus"
  | "listCollaborationMembers"
  | "listCollaborationAssignments"
  | "listCollaborationEligibleAssignees"
  | "listCollaborationComments"
  | "listCollaborationActivity"
  | "updateCollaborationAssignment"
  | "createCollaborationComment"
  | "editCollaborationComment"
  | "tombstoneCollaborationComment"
  | "onCollaborationStatusChanged"
  | "onCollaborationObserverSignal"
>;

export type CollaborationReadModelControllerOptions = {
  api: CollaborationReadBridgePort;
  /** Bound list page size for authoritative refreshes. */
  pageLimit?: number;
  clock?: { now(): Date };
  /** Deterministic mutation ids for tests. */
  createMutationId?: () => string;
};

type InternalState = {
  profileId: string | null;
  projectId: string | null;
  canvasId: string | null;
  syncPhase: CollaborationSyncPhase;
  observerCursor: number;
  members: HumanMembershipView[];
  hosts: Map<string, CollaborationHostProjection>;
  assignments: Map<string, AssignmentDisplayProjection>;
  comments: Map<string, CommentDisplayProjection[]>;
  activity: CollaborationReadModelSnapshot["activity"];
  remoteRuns: Map<string, CollaborationRemoteRunProjection>;
  mutations: Map<string, CollaborationMutationRecord>;
  lastError: CollaborationBoundaryErrorView | null;
  loadingKinds: Set<string>;
  /** Work items whose comments are actively tracked (invalidate/reload). */
  trackedCommentWorkItems: Map<string, WorkItemRef>;
  /** Event cursors already applied (dedupe out-of-order/duplicate observer events). */
  appliedEventCursors: Set<number>;
  generation: number;
  updatedAt: string;
};

const DEFAULT_PAGE_LIMIT = 50;

function emptyState(now: string): InternalState {
  return {
    profileId: null,
    projectId: null,
    canvasId: null,
    syncPhase: "idle",
    observerCursor: 0,
    members: [],
    hosts: new Map(),
    assignments: new Map(),
    comments: new Map(),
    activity: [],
    remoteRuns: new Map(),
    mutations: new Map(),
    lastError: null,
    loadingKinds: new Set(),
    trackedCommentWorkItems: new Map(),
    appliedEventCursors: new Set(),
    generation: 0,
    updatedAt: now
  };
}

function errorFromUnknown(error: unknown): CollaborationBoundaryErrorView {
  if (
    error &&
    typeof error === "object" &&
    "kind" in error &&
    "code" in error &&
    typeof (error as { kind: unknown }).kind === "string" &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    const typed = error as {
      kind: string;
      code: string;
      message?: string;
      httpStatus?: number;
      retryable?: boolean;
    };
    return {
      kind: typed.kind,
      code: typed.code,
      message: typed.message ?? typed.code,
      httpStatus: typed.httpStatus,
      retryable: typed.retryable ?? false
    };
  }
  return {
    kind: "unknown",
    code: "collaboration_unknown",
    message: error instanceof Error ? error.message : String(error),
    retryable: false
  };
}

function mapSessionPhaseToSync(
  status: CollaborationStatus,
  current: CollaborationSyncPhase
): CollaborationSyncPhase {
  const phase = status.session.phase;
  const detail = status.session.detail ?? "";
  if (status.session.lastErrorCode === "human_device_expired" || detail.includes("auth_expired")) {
    return "auth_expired";
  }
  if (
    status.session.lastErrorCode?.includes("forbidden") ||
    status.session.lastErrorCode === "http_403"
  ) {
    return "forbidden";
  }
  if (phase === "idle") return "disconnected";
  if (phase === "connecting") {
    if (detail.includes("reconnecting")) return "reconnecting";
    return current === "ready" || current === "degraded" ? "reconnecting" : "loading";
  }
  if (phase === "error") {
    if (detail.includes("auth_expired")) return "auth_expired";
    return "error";
  }
  if (phase === "connected" || phase === "ready") {
    if (current === "loading") return "loading";
    if (current === "stale_conflict") return "stale_conflict";
    if (current === "degraded") return "degraded";
    return current === "idle" || current === "disconnected" || current === "error"
      ? "loading"
      : current === "reconnecting"
        ? "ready"
        : current;
  }
  return current;
}

function remoteStatusFromActivityType(type: string): CollaborationRemoteRunStatus | null {
  switch (type) {
    case "remote_run_started":
      return "started";
    case "remote_run_succeeded":
      return "succeeded";
    case "remote_run_failed":
      return "failed";
    case "remote_run_interrupted":
      return "interrupted";
    default:
      return null;
  }
}

/**
 * Owns server collaboration projections for one active profile/project.
 * Components subscribe to snapshots; they never open their own observer connections.
 */
export class CollaborationReadModelController {
  private readonly api: CollaborationReadBridgePort;
  private readonly pageLimit: number;
  private readonly clock: { now(): Date };
  private readonly createMutationId: () => string;
  private state: InternalState;
  private listeners = new Set<(snapshot: CollaborationReadModelSnapshot) => void>();
  private unsubscribers: Array<() => void> = [];
  private disposed = false;
  private mutationSeq = 0;
  private refreshQueue: Promise<void> = Promise.resolve();
  /** Cached for useSyncExternalStore — must be referentially stable between emissions. */
  private cachedSnapshot: CollaborationReadModelSnapshot;

  constructor(options: CollaborationReadModelControllerOptions) {
    this.api = options.api;
    this.pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
    this.clock = options.clock ?? { now: () => new Date() };
    this.createMutationId =
      options.createMutationId ??
      (() => {
        this.mutationSeq += 1;
        return `mut-${this.mutationSeq}`;
      });
    this.state = emptyState(this.clock.now().toISOString());
    this.cachedSnapshot = this.buildSnapshot();
  }

  getSnapshot(): CollaborationReadModelSnapshot {
    return this.cachedSnapshot;
  }

  subscribe(listener: (snapshot: CollaborationReadModelSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Bind to an active collaboration profile/project and load authoritative projections.
   * Stops previous subscriptions when the project identity changes.
   */
  async setActiveProject(input: {
    profileId: string;
    projectId: string;
    canvasId?: string | null;
  }): Promise<void> {
    this.assertOpen();
    const sameIdentity =
      this.state.profileId === input.profileId && this.state.projectId === input.projectId;
    if (!sameIdentity) {
      this.teardownSubscriptions();
      this.state = {
        ...emptyState(this.clock.now().toISOString()),
        profileId: input.profileId,
        projectId: input.projectId,
        canvasId: input.canvasId ?? null,
        syncPhase: "loading",
        generation: this.state.generation + 1
      };
      this.attachSubscriptions();
      this.emit();
    } else if ((input.canvasId ?? null) !== this.state.canvasId) {
      this.state.canvasId = input.canvasId ?? null;
      this.state.generation += 1;
    }

    const generation = this.state.generation;
    await this.refreshAuthoritative({ reason: "set_active_project" }, generation);
  }

  /** Stop all subscriptions and clear server projections (project switch / logout). */
  clear(): void {
    this.teardownSubscriptions();
    this.state = emptyState(this.clock.now().toISOString());
    this.emit();
  }

  dispose(): void {
    this.clear();
    this.disposed = true;
    this.listeners.clear();
  }

  /** Track comments for a work item and load the authoritative page. */
  async trackWorkItemComments(workItem: WorkItemRef): Promise<void> {
    this.assertOpen();
    if (!this.state.projectId) return;
    const key = workItemKey(workItem);
    this.state.trackedCommentWorkItems.set(key, workItem);
    await this.reloadComments(workItem, this.state.generation);
  }

  async refreshAuthoritative(
    _meta: { reason: string } = { reason: "manual" },
    generation = this.state.generation
  ): Promise<void> {
    this.assertOpen();
    if (!this.state.profileId || !this.state.projectId) return;

    this.refreshQueue = this.refreshQueue
      .catch(() => undefined)
      .then(async () => {
        if (this.disposed || generation !== this.state.generation) return;
        this.setLoading("snapshot", true);
        if (this.state.syncPhase !== "reconnecting" && this.state.syncPhase !== "auth_expired") {
          this.state.syncPhase = "loading";
        }
        this.emit();

        const results = await Promise.allSettled([
          this.reloadMembers(generation),
          this.reloadAssignments(generation),
          this.reloadActivity(generation),
          ...[...this.state.trackedCommentWorkItems.values()].map((workItem) =>
            this.reloadComments(workItem, generation)
          )
        ]);

        if (this.disposed || generation !== this.state.generation) return;

        this.setLoading("snapshot", false);
        const failures = results.filter((result) => result.status === "rejected");
        if (failures.length === 0) {
          this.markReadyUnlessTerminal();
        } else {
          const first = failures[0] as PromiseRejectedResult;
          const mapped = errorFromUnknown(first.reason);
          this.applyBoundaryError(mapped);
        }
        this.emit();
      });

    await this.refreshQueue;
  }

  async updateAssignment(
    command: CollaborationAssignmentUpdateInput
  ): Promise<AssignmentDisplayProjection | null> {
    return this.runMutation({
      kind: "assignment",
      workItem: command.workItem,
      expectedRevision: command.expectedRevision,
      execute: () => this.api.updateCollaborationAssignment(command),
      onConfirmed: (projection) => {
        this.state.assignments.set(workItemKey(projection.workItem), projection);
        this.ingestHostsFromAssignment(projection);
      }
    });
  }

  async createComment(
    command: CollaborationCommentCreateInput
  ): Promise<CommentDisplayProjection | null> {
    return this.runMutation({
      kind: "comment_create",
      workItem: command.workItem,
      execute: () => this.api.createCollaborationComment(command),
      onConfirmed: (projection) => {
        this.upsertComment(projection);
      }
    });
  }

  async editComment(
    command: CollaborationCommentEditInput
  ): Promise<CommentDisplayProjection | null> {
    return this.runMutation({
      kind: "comment_edit",
      expectedRevision: command.expectedRevision,
      execute: () => this.api.editCollaborationComment(command),
      onConfirmed: (projection) => {
        this.upsertComment(projection);
      }
    });
  }

  async tombstoneComment(
    command: CollaborationCommentTombstoneInput
  ): Promise<CommentDisplayProjection | null> {
    return this.runMutation({
      kind: "comment_tombstone",
      expectedRevision: command.expectedRevision,
      execute: () => this.api.tombstoneCollaborationComment(command),
      onConfirmed: (projection) => {
        this.upsertComment(projection);
      }
    });
  }

  /** Test / advanced: inject status without bridge. */
  handleStatusForTests(status: CollaborationStatus): void {
    this.handleStatus(status);
  }

  /** Test / advanced: inject observer signal without bridge. */
  handleObserverSignalForTests(signal: CollaborationObserverSignal): void {
    void this.handleObserverSignal(signal);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private attachSubscriptions(): void {
    this.unsubscribers.push(
      this.api.onCollaborationStatusChanged((status) => this.handleStatus(status)),
      this.api.onCollaborationObserverSignal((signal) => {
        void this.handleObserverSignal(signal);
      })
    );
  }

  private teardownSubscriptions(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // ignore unsubscribe races
      }
    }
  }

  private handleStatus(status: CollaborationStatus): void {
    if (this.disposed) return;
    if (this.state.profileId && status.session.activeProfileId) {
      if (status.session.activeProfileId !== this.state.profileId) {
        // Active profile switched elsewhere — clear this controller's cache.
        this.clear();
        return;
      }
    }
    const nextPhase = mapSessionPhaseToSync(status, this.state.syncPhase);
    if (nextPhase !== this.state.syncPhase) {
      this.state.syncPhase = nextPhase;
      this.state.updatedAt = this.clock.now().toISOString();
      if (status.session.lastErrorCode) {
        this.state.lastError = {
          kind: nextPhase === "auth_expired" ? "auth" : "unknown",
          code: status.session.lastErrorCode,
          message: status.session.lastErrorMessage ?? status.session.lastErrorCode,
          retryable: nextPhase === "reconnecting"
        };
      }
      this.emit();
    }
  }

  private async handleObserverSignal(signal: CollaborationObserverSignal): Promise<void> {
    if (this.disposed) return;
    if (this.state.profileId && signal.profileId !== this.state.profileId) return;
    if (this.state.projectId && signal.projectId !== this.state.projectId) return;

    const generation = this.state.generation;

    if (signal.type === "human.observer.cursor") {
      if (signal.cursor >= this.state.observerCursor) {
        this.state.observerCursor = signal.cursor;
        this.emit();
      }
      return;
    }

    if (signal.type === "human.observer.catchup_required") {
      // Retention gap / cursor reset: drop cached projections and reload bounded APIs.
      this.state.observerCursor = signal.resumeCursor;
      this.state.appliedEventCursors.clear();
      this.state.assignments.clear();
      this.state.comments.clear();
      this.state.activity = [];
      this.state.remoteRuns.clear();
      this.state.hosts.clear();
      this.state.members = [];
      this.state.syncPhase = "loading";
      this.emit();
      await this.refreshAuthoritative({ reason: "catchup_required" }, generation);
      return;
    }

    // human.observer.event
    const event = signal.event;
    if (this.state.appliedEventCursors.has(event.cursor)) {
      return;
    }
    if (event.cursor <= this.state.observerCursor && this.state.observerCursor > 0) {
      // Out-of-order or stale duplicate relative to validated high-water mark.
      if (event.previousCursor < this.state.observerCursor) {
        this.state.appliedEventCursors.add(event.cursor);
        return;
      }
    }
    this.state.appliedEventCursors.add(event.cursor);
    if (event.cursor > this.state.observerCursor) {
      this.state.observerCursor = event.cursor;
    }

    await this.invalidateFromEvent(event.kind, event, generation);
  }

  private async invalidateFromEvent(
    kind: HumanObserverEvent["kind"],
    event: HumanObserverEvent,
    generation: number
  ): Promise<void> {
    if (generation !== this.state.generation) return;

    switch (kind) {
      case "membership":
      case "invitation":
      case "project":
        await this.reloadMembers(generation);
        break;
      case "assignment":
        if (event.workItem) {
          await this.reloadAssignmentForWorkItem(event.workItem, generation);
        } else {
          await this.reloadAssignments(generation);
        }
        break;
      case "comment":
        if (event.workItem) {
          this.state.trackedCommentWorkItems.set(workItemKey(event.workItem), event.workItem);
          await this.reloadComments(event.workItem, generation);
        }
        break;
      case "activity":
        await this.reloadActivity(generation);
        break;
      case "remote_run":
        if (event.dispatchId && event.remoteRunStatus) {
          const existing = this.state.remoteRuns.get(event.dispatchId);
          this.state.remoteRuns.set(event.dispatchId, {
            dispatchId: event.dispatchId,
            projectId: this.state.projectId ?? existing?.projectId ?? "",
            workItem: event.workItem ?? existing?.workItem,
            hostId: existing?.hostId,
            status: event.remoteRunStatus,
            lastActivityId: existing?.lastActivityId,
            updatedAt: event.occurredAt
          });
          this.emit();
        } else {
          await this.reloadActivity(generation);
        }
        break;
      case "attachment":
        if (event.workItem) {
          this.state.trackedCommentWorkItems.set(workItemKey(event.workItem), event.workItem);
          await this.reloadComments(event.workItem, generation);
        }
        break;
      default:
        break;
    }
  }

  private async reloadMembers(generation: number): Promise<void> {
    this.setLoading("members", true);
    this.emit();
    try {
      const page = await this.api.listCollaborationMembers({
        cursor: 0,
        limit: this.pageLimit
      });
      if (generation !== this.state.generation) return;
      this.state.members = page.items;
      this.setLoading("members", false);
      this.emit();
    } catch (error) {
      this.setLoading("members", false);
      throw error;
    }
  }

  private async reloadAssignments(generation: number): Promise<void> {
    this.setLoading("assignments", true);
    this.emit();
    try {
      const query: CollaborationAssignmentListQueryInput = {
        cursor: 0,
        limit: this.pageLimit,
        ...(this.state.canvasId ? { canvasId: this.state.canvasId } : {})
      };
      const page = await this.api.listCollaborationAssignments(query);
      if (generation !== this.state.generation) return;
      this.state.assignments.clear();
      for (const item of page.items) {
        this.state.assignments.set(workItemKey(item.workItem), item);
        this.ingestHostsFromAssignment(item);
      }
      // Hosts: pull eligible assignees for first assignment when available (bounded).
      const first = page.items[0];
      if (first) {
        try {
          const eligible = await this.api.listCollaborationEligibleAssignees({
            workItem: first.workItem
          });
          if (generation !== this.state.generation) return;
          for (const host of eligible.hosts) {
            this.state.hosts.set(host.hostId, {
              hostId: host.hostId,
              projectId: host.projectId,
              displayName: host.displayName,
              online: host.online,
              revoked: host.revoked,
              authorizedForProject: host.authorizedForProject,
              exists: host.exists,
              capabilities: host.capabilities,
              capacityRemaining: host.capacityRemaining
            });
          }
        } catch {
          // Host listing is best-effort; assignments remain authoritative.
        }
      }
      this.setLoading("assignments", false);
      this.emit();
    } catch (error) {
      this.setLoading("assignments", false);
      throw error;
    }
  }

  private async reloadAssignmentForWorkItem(
    workItem: WorkItemRef,
    generation: number
  ): Promise<void> {
    this.setLoading("assignments", true);
    this.emit();
    try {
      const page = await this.api.listCollaborationAssignments({
        cursor: 0,
        limit: 1,
        workItems: [workItem]
      });
      if (generation !== this.state.generation) return;
      const key = workItemKey(workItem);
      const item = page.items[0];
      if (item) {
        this.state.assignments.set(key, item);
        this.ingestHostsFromAssignment(item);
      }
      this.setLoading("assignments", false);
      this.emit();
    } catch (error) {
      this.setLoading("assignments", false);
      throw error;
    }
  }

  private async reloadComments(workItem: WorkItemRef, generation: number): Promise<void> {
    const key = workItemKey(workItem);
    this.setLoading(`comments:${key}`, true);
    this.emit();
    try {
      const query: CollaborationCommentListQueryInput = {
        workItem,
        limit: this.pageLimit,
        includeTombstoned: false
      };
      const page = await this.api.listCollaborationComments(query);
      if (generation !== this.state.generation) return;
      this.state.comments.set(key, page.items);
      this.setLoading(`comments:${key}`, false);
      this.emit();
    } catch (error) {
      this.setLoading(`comments:${key}`, false);
      throw error;
    }
  }

  private async reloadActivity(generation: number): Promise<void> {
    this.setLoading("activity", true);
    this.emit();
    try {
      const query: CollaborationActivityListQueryInput = {
        limit: this.pageLimit
      };
      const page = await this.api.listCollaborationActivity(query);
      if (generation !== this.state.generation) return;
      this.state.activity = page.items;
      for (const record of page.items) {
        const status = remoteStatusFromActivityType(record.type);
        if (!status) continue;
        const dispatchId = record.summary.dispatchId ?? record.source.sourceId;
        if (!dispatchId) continue;
        const next: CollaborationRemoteRunProjection = {
          dispatchId,
          projectId: record.projectId,
          workItem: record.workItem ?? record.summary.workItem,
          hostId: record.summary.hostId,
          status,
          lastActivityId: record.activityId,
          updatedAt: record.occurredAt
        };
        const existing = this.state.remoteRuns.get(dispatchId);
        // Prefer newer observer progress over older activity replay.
        if (!existing || existing.updatedAt <= next.updatedAt) {
          this.state.remoteRuns.set(dispatchId, next);
        }
      }
      this.setLoading("activity", false);
      this.emit();
    } catch (error) {
      this.setLoading("activity", false);
      throw error;
    }
  }

  private async runMutation<T extends { revision?: number; workItem?: WorkItemRef }>(input: {
    kind: CollaborationMutationRecord["kind"];
    workItem?: WorkItemRef;
    expectedRevision?: number;
    execute: () => Promise<T>;
    onConfirmed: (result: T) => void;
  }): Promise<T | null> {
    this.assertOpen();
    const mutationId = this.createMutationId();
    const workItemKeyValue = input.workItem ? workItemKey(input.workItem) : undefined;
    const record: CollaborationMutationRecord = {
      mutationId,
      kind: input.kind,
      workItemKey: workItemKeyValue,
      status: "pending",
      expectedRevision: input.expectedRevision,
      submittedAt: this.clock.now().toISOString()
    };
    this.state.mutations.set(mutationId, record);
    this.emit();

    try {
      const result = await input.execute();
      const confirmed: CollaborationMutationRecord = {
        ...record,
        status: "confirmed",
        confirmedRevision:
          typeof result.revision === "number" ? result.revision : input.expectedRevision,
        resolvedAt: this.clock.now().toISOString()
      };
      this.state.mutations.set(mutationId, confirmed);
      input.onConfirmed(result);
      if (this.state.syncPhase === "stale_conflict") {
        this.state.syncPhase = "ready";
      }
      this.state.lastError = null;
      this.emit();
      return result;
    } catch (error) {
      const mapped = errorFromUnknown(error);
      const status: CollaborationMutationRecord["status"] =
        mapped.kind === "offline" || mapped.kind === "timeout" ? "offline" : "rejected";
      this.state.mutations.set(mutationId, {
        ...record,
        status,
        errorKind: mapped.kind,
        errorCode: mapped.code,
        errorMessage: mapped.message,
        resolvedAt: this.clock.now().toISOString()
      });
      this.applyBoundaryError(mapped);
      this.emit();
      return null;
    }
  }

  private markReadyUnlessTerminal(): void {
    const terminal: CollaborationSyncPhase[] = ["auth_expired", "forbidden", "stale_conflict"];
    if (!terminal.includes(this.state.syncPhase)) {
      this.state.syncPhase = "ready";
      this.state.lastError = null;
    }
  }

  private applyBoundaryError(error: CollaborationBoundaryErrorView): void {
    this.state.lastError = error;
    if (error.kind === "auth") {
      this.state.syncPhase = "auth_expired";
    } else if (error.kind === "forbidden") {
      this.state.syncPhase = "forbidden";
    } else if (error.kind === "conflict") {
      this.state.syncPhase = "stale_conflict";
    } else if (error.kind === "offline" || error.kind === "timeout") {
      this.state.syncPhase =
        this.state.syncPhase === "ready" || this.state.syncPhase === "degraded"
          ? "degraded"
          : this.state.syncPhase === "loading"
            ? "disconnected"
            : this.state.syncPhase;
    } else if (this.state.syncPhase === "loading" || this.state.syncPhase === "ready") {
      this.state.syncPhase = "degraded";
    }
  }

  private ingestHostsFromAssignment(assignment: AssignmentDisplayProjection): void {
    if (!assignment.host) return;
    const existing = this.state.hosts.get(assignment.host.hostId);
    this.state.hosts.set(assignment.host.hostId, {
      hostId: assignment.host.hostId,
      projectId: assignment.projectId,
      displayName: assignment.host.displayName,
      online: assignment.host.online,
      revoked: assignment.host.revoked,
      authorizedForProject: assignment.host.authorizedForProject,
      exists: true,
      capabilities: existing?.capabilities ?? [],
      capacityRemaining: existing?.capacityRemaining
    });
  }

  private upsertComment(projection: CommentDisplayProjection): void {
    const key = workItemKey(projection.workItem);
    const existing = this.state.comments.get(key) ?? [];
    const next = existing.filter((item) => item.commentId !== projection.commentId);
    next.push(projection);
    next.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    this.state.comments.set(key, next);
    this.state.trackedCommentWorkItems.set(key, projection.workItem);
  }

  private setLoading(kind: string, loading: boolean): void {
    if (loading) this.state.loadingKinds.add(kind);
    else this.state.loadingKinds.delete(kind);
  }

  private buildSnapshot(): CollaborationReadModelSnapshot {
    return {
      profileId: this.state.profileId,
      projectId: this.state.projectId,
      canvasId: this.state.canvasId,
      syncPhase: this.state.syncPhase,
      observerCursor: this.state.observerCursor,
      members: this.state.members,
      hosts: [...this.state.hosts.values()],
      assignmentsByWorkItem: Object.fromEntries(this.state.assignments),
      commentsByWorkItem: Object.fromEntries(this.state.comments),
      activity: this.state.activity,
      remoteRunsByDispatchId: Object.fromEntries(this.state.remoteRuns),
      mutationsById: Object.fromEntries(this.state.mutations),
      lastError: this.state.lastError,
      loadingKinds: [...this.state.loadingKinds],
      updatedAt: this.state.updatedAt
    };
  }

  private emit(): void {
    this.state.updatedAt = this.clock.now().toISOString();
    this.cachedSnapshot = this.buildSnapshot();
    const snapshot = this.cachedSnapshot;
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new Error("CollaborationReadModelController has been disposed.");
    }
  }
}
