import {
  activityListPageSchema,
  activityListWireQuerySchema,
  assertHumanDisplayDtoRedacted,
  assignmentDisplayProjectionSchema,
  assignmentListPageSchema,
  assignmentListQuerySchema,
  assignmentUpdateWireCommandSchema,
  collaborationClientLimitsSchema,
  collaborationConnectionProfileSchema,
  commentCreateWireCommandSchema,
  commentDisplayProjectionSchema,
  commentEditWireCommandSchema,
  commentListPageSchema,
  commentListWireQuerySchema,
  commentTombstoneWireCommandSchema,
  createPendingAttachmentRequestSchema,
  eligibleAssigneesResponseSchema,
  finalizePendingAttachmentResponseSchema,
  humanBootstrapRequestSchema,
  humanBootstrapResponseSchema,
  humanConsumeInvitationRequestSchema,
  humanConsumeInvitationResponseSchema,
  humanCreateInvitationRequestSchema,
  humanCreateInvitationResponseSchema,
  humanDeviceListQuerySchema,
  humanDevicePageSchema,
  humanInvitationListQuerySchema,
  humanInvitationPageSchema,
  humanInvitationViewSchema,
  humanMemberPageSchema,
  humanObserverHelloSchema,
  humanPageQuerySchema,
  HUMAN_OBSERVER_PROTOCOL_VERSION,
  parseHumanObserverServerMessage,
  pendingAttachmentViewSchema,
  remoteActionViewSchema,
  remoteDispatchWireCommandSchema,
  remoteEventQuerySchema,
  remoteEventReplaySchema,
  remoteHumanExecutionActionCommandSchema,
  remoteInteractionPageQuerySchema,
  remoteInteractionPageSchema,
  remoteInteractionResponseSchema,
  remoteInteractionViewSchema,
  remoteOperationObservationSchema,
  uploadPendingAttachmentResponseSchema,
  type ActivityListPage,
  type AssignmentDisplayProjection,
  type AssignmentListPage,
  type AssignmentUpdateWireCommand,
  type CanvasPresenceError,
  type CanvasPresenceLeave,
  type CanvasPresencePointer,
  type CanvasPresenceSelectionId,
  type CanvasPresenceSnapshot,
  type CanvasPresenceUpdate,
  type CollaborationClientLimits,
  type CollaborationConnectionProfile,
  type CommentCreateWireCommand,
  type CommentDisplayProjection,
  type CommentEditWireCommand,
  type CommentListPage,
  type CommentListWireQuery,
  type CommentTombstoneWireCommand,
  type CreatePendingAttachmentRequest,
  type EligibleAssigneesResponse,
  type FinalizePendingAttachmentResponse,
  type HumanBootstrapRequest,
  type HumanBootstrapResponse,
  type HumanConsumeInvitationRequest,
  type HumanConsumeInvitationResponse,
  type HumanCreateInvitationResponse,
  type HumanDevicePage,
  type HumanInvitationPage,
  type HumanInvitationView,
  type HumanMemberPage,
  type HumanObserverCursor,
  type HumanObserverServerMessage,
  type PendingAttachmentView,
  type RemoteActionView,
  type RemoteDispatchWireCommand,
  type RemoteEventReplay,
  type RemoteHumanExecutionActionCommand,
  type RemoteInteractionPage,
  type RemoteInteractionResponse,
  type RemoteInteractionView,
  type RemoteOperationObservation,
  type WorkItemRef
} from "@planweave-ai/collaboration-contracts";
import type { z, ZodType } from "zod";
import {
  CollaborationClientError,
  collaborationErrorFromHttp,
  collaborationErrorFromUnknown
} from "./collaborationErrors.js";
import { reconnectDelay } from "./reconnectBackoff.js";
import { redactCollaborationText } from "./redaction.js";
import { CanvasPresenceClient } from "./CanvasPresenceClient.js";
import { CollaborationRegistryClient } from "./CollaborationRegistryClient.js";

export type CollaborationCredentialPort = {
  /** Returns the current human device bearer (`pw_hdev_…`) or undefined when unauthenticated. */
  getDeviceToken(): string | undefined | Promise<string | undefined>;
};

export type CollaborationClientClock = {
  now(): Date;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
};

export type CollaborationObserverStatus =
  | { readonly state: "stopped" }
  | { readonly state: "connecting"; readonly attempt: number }
  | {
      readonly state: "connected";
      readonly cursor: HumanObserverCursor;
      readonly connectedAt: string;
    }
  | { readonly state: "catching_up"; readonly resumeCursor: HumanObserverCursor }
  | { readonly state: "reconnecting"; readonly attempt: number; readonly delayMs: number }
  | { readonly state: "auth_expired"; readonly code: string }
  | { readonly state: "failed"; readonly code: string };

export type CollaborationObserverHandlers = {
  onEvent?(message: Extract<HumanObserverServerMessage, { type: "human.observer.event" }>): void;
  onCatchupRequired?(
    message: Extract<HumanObserverServerMessage, { type: "human.observer.catchup_required" }>
  ): void;
  onAuthExpired?(
    message: Extract<HumanObserverServerMessage, { type: "human.observer.auth_expired" }>
  ): void;
  onStatus?(status: CollaborationObserverStatus): void;
};

export type CollaborationPresenceStatus =
  | { readonly state: "stopped" }
  | { readonly state: "connecting"; readonly canvasId: string; readonly attempt: number }
  | { readonly state: "connected"; readonly canvasId: string }
  | {
      readonly state: "reconnecting";
      readonly canvasId: string;
      readonly attempt: number;
      readonly delayMs: number;
    }
  | { readonly state: "auth_expired"; readonly canvasId: string; readonly code: string }
  | { readonly state: "error"; readonly canvasId: string; readonly code: string };

export type CollaborationPresenceHandlers = {
  onSnapshot?(message: CanvasPresenceSnapshot): void;
  onUpdate?(message: CanvasPresenceUpdate): void;
  onLeave?(message: CanvasPresenceLeave): void;
  onError?(message: CanvasPresenceError): void;
  onStatus?(status: CollaborationPresenceStatus): void;
};

export type CollaborationWebSocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: unknown) => void
  ): void;
  removeEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: unknown) => void
  ): void;
};

export type CollaborationWebSocketConstructor = new (
  url: string,
  protocolsOrOptions?: string | string[] | { headers?: Record<string, string> }
) => CollaborationWebSocketLike;

export type CollaborationClientOptions = {
  profile: CollaborationConnectionProfile;
  credential: CollaborationCredentialPort;
  limits?: Partial<CollaborationClientLimits>;
  request?: typeof fetch;
  WebSocketImpl?: CollaborationWebSocketConstructor;
  clock?: CollaborationClientClock;
  random?: () => number;
  logger?: { warn?(message: string): void; error?(message: string): void };
};

type JsonMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

const systemClock: CollaborationClientClock = {
  now: () => new Date(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
};

/**
 * Electron-main human collaboration client.
 *
 * Application-shaped methods only — no raw `request(path)` or socket access for callers.
 * Validates every JSON response/event with collaboration-contracts Zod schemas.
 */
export class CollaborationClient {
  private readonly profile: CollaborationConnectionProfile;
  private readonly limits: CollaborationClientLimits;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: CollaborationClientClock;
  private readonly random: () => number;
  private readonly rootController = new AbortController();
  private disposed = false;

  private observerSocket?: CollaborationWebSocketLike;
  private observerHandlers?: CollaborationObserverHandlers;
  private observerStatus: CollaborationObserverStatus = { state: "stopped" };
  private observerCursor: HumanObserverCursor = 0;
  private observerReconnectAttempt = 0;
  private observerReconnectTimer?: unknown;
  private observerWanted = false;

  private readonly presence: CanvasPresenceClient;
  private readonly registryClient: CollaborationRegistryClient;

  constructor(private readonly options: CollaborationClientOptions) {
    this.profile = collaborationConnectionProfileSchema.parse(options.profile);
    this.limits = collaborationClientLimitsSchema.parse(options.limits ?? {});
    this.fetchImpl = options.request ?? fetch;
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? Math.random;
    this.presence = new CanvasPresenceClient({
      profile: this.profile,
      credential: options.credential,
      WebSocketImpl: options.WebSocketImpl,
      clock: this.clock,
      random: this.random,
      reconnectInitialDelayMs: this.limits.reconnectInitialDelayMs,
      reconnectMaxDelayMs: this.limits.reconnectMaxDelayMs,
      logger: options.logger
    });
    this.registryClient = new CollaborationRegistryClient((method, path, schema, requestOptions) =>
      this.json(method, path, schema, {
        ...requestOptions,
        auth: true
      })
    );
  }

  get projectId(): string {
    return this.profile.projectId;
  }

  get connectionProfile(): CollaborationConnectionProfile {
    return this.profile;
  }

  registry(): CollaborationRegistryClient {
    return this.registryClient;
  }

  observerState(): CollaborationObserverStatus {
    return this.observerStatus;
  }

  lastObserverCursor(): HumanObserverCursor {
    return this.observerCursor;
  }

  presenceState(): CollaborationPresenceStatus {
    return this.presence.state();
  }

  presenceCanvas(): string | null {
    return this.presence.canvas();
  }

  // ---------------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------------

  async bootstrapOwner(
    input: HumanBootstrapRequest,
    signal?: AbortSignal
  ): Promise<HumanBootstrapResponse> {
    const body = humanBootstrapRequestSchema.parse(input);
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/human/bootstrap`,
      humanBootstrapResponseSchema,
      { body, auth: false, signal }
    );
  }

  async consumeInvitation(
    input: HumanConsumeInvitationRequest,
    signal?: AbortSignal
  ): Promise<HumanConsumeInvitationResponse> {
    const body = humanConsumeInvitationRequestSchema.parse(input);
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/human/invitations/consume`,
      humanConsumeInvitationResponseSchema,
      { body, auth: false, signal }
    );
  }

  async createInvitation(
    input: z.input<typeof humanCreateInvitationRequestSchema> = {},
    signal?: AbortSignal
  ): Promise<HumanCreateInvitationResponse> {
    const body = humanCreateInvitationRequestSchema.parse(input);
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/human/invitations`,
      humanCreateInvitationResponseSchema,
      { body, signal }
    );
  }

  async listInvitations(
    query: z.input<typeof humanInvitationListQuerySchema> = {},
    signal?: AbortSignal
  ): Promise<HumanInvitationPage> {
    const q = humanInvitationListQuerySchema.parse(query);
    const params = new URLSearchParams({
      cursor: String(q.cursor),
      limit: String(q.limit)
    });
    if (q.openOnly !== undefined) params.set("openOnly", q.openOnly ? "true" : "false");
    return this.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/human/invitations?${params}`,
      humanInvitationPageSchema,
      { signal }
    );
  }

  async revokeInvitation(invitationId: string, signal?: AbortSignal): Promise<HumanInvitationView> {
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/human/invitations/${encodeURIComponent(invitationId)}/revoke`,
      humanInvitationViewSchema,
      { body: {}, signal }
    );
  }

  async listMembers(
    query: z.input<typeof humanPageQuerySchema> = {},
    signal?: AbortSignal
  ): Promise<HumanMemberPage> {
    const q = humanPageQuerySchema.parse(query);
    const params = new URLSearchParams({
      cursor: String(q.cursor),
      limit: String(q.limit)
    });
    return this.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/human/members?${params}`,
      humanMemberPageSchema,
      { signal }
    );
  }

  async removeMember(humanPrincipalId: string, signal?: AbortSignal): Promise<void> {
    await this.jsonEmpty(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/human/members/${encodeURIComponent(humanPrincipalId)}/remove`,
      { body: {}, signal }
    );
  }

  async promoteOwner(humanPrincipalId: string, signal?: AbortSignal): Promise<void> {
    await this.jsonEmpty(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/human/members/${encodeURIComponent(humanPrincipalId)}/promote`,
      { body: {}, signal }
    );
  }

  async demoteOwner(humanPrincipalId: string, signal?: AbortSignal): Promise<void> {
    await this.jsonEmpty(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/human/members/${encodeURIComponent(humanPrincipalId)}/demote`,
      { body: {}, signal }
    );
  }

  async listDevices(
    query: z.input<typeof humanDeviceListQuerySchema> = {},
    signal?: AbortSignal
  ): Promise<HumanDevicePage> {
    const q = humanDeviceListQuerySchema.parse(query);
    const params = new URLSearchParams({
      cursor: String(q.cursor),
      limit: String(q.limit),
      scope: q.scope
    });
    return this.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/human/devices?${params}`,
      humanDevicePageSchema,
      { signal }
    );
  }

  async revokeDevice(deviceCredentialId: string, signal?: AbortSignal): Promise<void> {
    await this.jsonEmpty(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/human/devices/${encodeURIComponent(deviceCredentialId)}/revoke`,
      { body: {}, signal }
    );
  }

  // ---------------------------------------------------------------------------
  // Assignments (application wire paths; Server HTTP may land after domain)
  // ---------------------------------------------------------------------------

  async getAssignment(
    workItem: WorkItemRef,
    signal?: AbortSignal
  ): Promise<AssignmentDisplayProjection> {
    const params = new URLSearchParams({ workItem: JSON.stringify(workItem) });
    return this.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/assignments?${params}`,
      assignmentDisplayProjectionSchema,
      { signal }
    );
  }

  async listAssignments(
    query: z.input<typeof assignmentListQuerySchema> = {},
    signal?: AbortSignal
  ): Promise<AssignmentListPage> {
    const q = assignmentListQuerySchema.parse(query);
    const params = new URLSearchParams({
      cursor: String(q.cursor),
      limit: String(q.limit)
    });
    if (q.canvasId) params.set("canvasId", q.canvasId);
    if (q.workItems) params.set("workItems", JSON.stringify(q.workItems));
    return this.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/assignments/list?${params}`,
      assignmentListPageSchema,
      { signal }
    );
  }

  async updateAssignment(
    command: AssignmentUpdateWireCommand,
    signal?: AbortSignal
  ): Promise<AssignmentDisplayProjection> {
    const body = assignmentUpdateWireCommandSchema.parse(command);
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/assignments`,
      assignmentDisplayProjectionSchema,
      { body, signal }
    );
  }

  async listEligibleAssignees(
    workItem: WorkItemRef,
    signal?: AbortSignal
  ): Promise<EligibleAssigneesResponse> {
    const params = new URLSearchParams({ workItem: JSON.stringify(workItem) });
    return this.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/assignments/eligible-assignees?${params}`,
      eligibleAssigneesResponseSchema,
      { signal }
    );
  }

  // ---------------------------------------------------------------------------
  // Comments / activity
  // ---------------------------------------------------------------------------

  async listComments(query: CommentListWireQuery, signal?: AbortSignal): Promise<CommentListPage> {
    const q = commentListWireQuerySchema.parse(query);
    const params = new URLSearchParams({
      workItem: JSON.stringify(q.workItem),
      limit: String(q.limit),
      includeTombstoned: q.includeTombstoned ? "true" : "false"
    });
    if (q.cursor) params.set("cursor", JSON.stringify(q.cursor));
    return this.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/comments?${params}`,
      commentListPageSchema,
      { signal }
    );
  }

  async createComment(
    command: CommentCreateWireCommand,
    signal?: AbortSignal
  ): Promise<CommentDisplayProjection> {
    const body = commentCreateWireCommandSchema.parse(command);
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/comments`,
      commentDisplayProjectionSchema,
      { body, signal }
    );
  }

  async editComment(
    command: CommentEditWireCommand,
    signal?: AbortSignal
  ): Promise<CommentDisplayProjection> {
    const body = commentEditWireCommandSchema.parse(command);
    return this.json(
      "PATCH",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/comments/${encodeURIComponent(body.commentId)}`,
      commentDisplayProjectionSchema,
      {
        body: { body: body.body, expectedRevision: body.expectedRevision },
        signal
      }
    );
  }

  async tombstoneComment(
    command: CommentTombstoneWireCommand,
    signal?: AbortSignal
  ): Promise<CommentDisplayProjection> {
    const body = commentTombstoneWireCommandSchema.parse(command);
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/comments/${encodeURIComponent(body.commentId)}/tombstone`,
      commentDisplayProjectionSchema,
      {
        body: { expectedRevision: body.expectedRevision, reason: body.reason },
        signal
      }
    );
  }

  async listActivity(
    query: z.input<typeof activityListWireQuerySchema> = {},
    signal?: AbortSignal
  ): Promise<ActivityListPage> {
    const q = activityListWireQuerySchema.parse(query);
    const params = new URLSearchParams({ limit: String(q.limit) });
    if (q.workItem) params.set("workItem", JSON.stringify(q.workItem));
    if (q.cursor) params.set("cursor", JSON.stringify(q.cursor));
    return this.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/activity?${params}`,
      activityListPageSchema,
      { signal }
    );
  }

  // ---------------------------------------------------------------------------
  // Remote ACP run observation / control (human remote_run_control)
  // Distinct from local Runtime Auto Run and Host mailbox.
  // ---------------------------------------------------------------------------

  async dispatchRemoteOperation(
    command: RemoteDispatchWireCommand,
    signal?: AbortSignal
  ): Promise<RemoteOperationObservation> {
    const body = remoteDispatchWireCommandSchema.parse(command);
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/remote-operations`,
      remoteOperationObservationSchema,
      { body, signal }
    );
  }

  async observeRemoteOperation(
    operationId: string,
    signal?: AbortSignal
  ): Promise<RemoteOperationObservation> {
    return this.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/remote-operations/${encodeURIComponent(operationId)}`,
      remoteOperationObservationSchema,
      { signal }
    );
  }

  async executeRemoteOperationAction(
    operationId: string,
    action: RemoteHumanExecutionActionCommand,
    signal?: AbortSignal
  ): Promise<RemoteActionView> {
    const body = remoteHumanExecutionActionCommandSchema.parse(action);
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/remote-operations/${encodeURIComponent(operationId)}/actions`,
      remoteActionViewSchema,
      { body, signal }
    );
  }

  async replayRemoteOperationEvents(
    operationId: string,
    query: z.input<typeof remoteEventQuerySchema> = {},
    signal?: AbortSignal
  ): Promise<RemoteEventReplay> {
    const q = remoteEventQuerySchema.parse(query);
    const params = new URLSearchParams({ afterCursor: String(q.afterCursor) });
    return this.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/remote-operations/${encodeURIComponent(operationId)}/events?${params}`,
      remoteEventReplaySchema,
      { signal }
    );
  }

  async listRemoteOperationInteractions(
    operationId: string,
    query: z.input<typeof remoteInteractionPageQuerySchema> = {},
    signal?: AbortSignal
  ): Promise<RemoteInteractionPage> {
    const q = remoteInteractionPageQuerySchema.parse(query);
    const params = new URLSearchParams({
      cursor: String(q.cursor),
      limit: String(q.limit)
    });
    return this.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/remote-operations/${encodeURIComponent(operationId)}/interactions?${params}`,
      remoteInteractionPageSchema,
      { signal }
    );
  }

  async settleRemoteOperationInteraction(
    operationId: string,
    settlement: RemoteInteractionResponse,
    signal?: AbortSignal
  ): Promise<RemoteInteractionView> {
    const body = remoteInteractionResponseSchema.parse(settlement);
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/remote-operations/${encodeURIComponent(operationId)}/interactions/respond`,
      remoteInteractionViewSchema,
      { body, signal }
    );
  }

  // ---------------------------------------------------------------------------
  // Attachments
  // ---------------------------------------------------------------------------

  async createPendingAttachment(
    input: CreatePendingAttachmentRequest,
    signal?: AbortSignal
  ): Promise<PendingAttachmentView> {
    const body = createPendingAttachmentRequestSchema.parse(input);
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/attachments/pending`,
      pendingAttachmentViewSchema,
      { body, signal }
    );
  }

  async uploadPendingAttachment(
    pendingUploadId: string,
    input: { body: Uint8Array; mediaType: string; digestSha256?: string },
    signal?: AbortSignal
  ): Promise<PendingAttachmentView> {
    this.ensureOpen();
    const path =
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}` +
      `/attachments/pending/${encodeURIComponent(pendingUploadId)}`;
    const headers: Record<string, string> = {
      "content-type": input.mediaType,
      "content-length": String(input.body.byteLength)
    };
    if (input.digestSha256) headers["x-planweave-content-sha256"] = input.digestSha256;
    await this.applyAuth(headers);
    const response = await this.send(path, {
      method: "PUT",
      headers,
      body: input.body,
      signal
    });
    const text = await this.readTextLimited(response);
    if (!response.ok) throw collaborationErrorFromHttp(response.status, text);
    const parsed = uploadPendingAttachmentResponseSchema.parse(JSON.parse(text));
    return pendingAttachmentViewSchema.parse({
      pendingUploadId: parsed.pendingUploadId,
      projectId: this.profile.projectId,
      expectedSizeBytes: parsed.sizeBytes ?? input.body.byteLength,
      mediaType: parsed.mediaType,
      status: parsed.status === "finalized" ? "finalized" : "uploaded",
      createdAt: this.clock.now().toISOString(),
      expiresAt: this.clock.now().toISOString(),
      digestSha256: parsed.digestSha256,
      uploadedAt: parsed.uploadedAt
    });
  }

  async finalizePendingAttachment(
    pendingUploadId: string,
    input: { expectedDigestSha256?: string } = {},
    signal?: AbortSignal
  ): Promise<FinalizePendingAttachmentResponse> {
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/attachments/pending/${encodeURIComponent(pendingUploadId)}/finalize`,
      finalizePendingAttachmentResponseSchema,
      { body: input, signal }
    );
  }

  // ---------------------------------------------------------------------------
  // Ephemeral canvas presence subscription
  // ---------------------------------------------------------------------------

  startPresence(canvasId: string, handlers: CollaborationPresenceHandlers = {}): void {
    this.ensureOpen();
    this.presence.start(canvasId, handlers);
  }

  /** Publish only bounded pointer/selection state for the currently selected canvas. */
  publishPresence(input: {
    pointer: CanvasPresencePointer | null;
    selectionIds: CanvasPresenceSelectionId[];
  }): void {
    this.ensureOpen();
    this.presence.publish(input);
  }

  stopPresence(): void {
    this.presence.stop();
  }

  // ---------------------------------------------------------------------------
  // Human observer subscription
  // ---------------------------------------------------------------------------

  /**
   * Start the distinct human observer WSS subscription.
   * Uses the last validated cursor for reconnect catch-up.
   */
  startObserver(handlers: CollaborationObserverHandlers = {}, options?: { cursor?: number }): void {
    this.ensureOpen();
    if (!this.options.WebSocketImpl) {
      throw new CollaborationClientError({
        kind: "protocol",
        code: "collaboration_websocket_unavailable",
        message: "WebSocket implementation was not provided to CollaborationClient."
      });
    }
    this.observerHandlers = handlers;
    this.observerWanted = true;
    if (options?.cursor !== undefined) this.observerCursor = options.cursor;
    this.connectObserver();
  }

  stopObserver(): void {
    this.observerWanted = false;
    if (this.observerReconnectTimer) this.clock.clearTimeout(this.observerReconnectTimer);
    this.observerReconnectTimer = undefined;
    const socket = this.observerSocket;
    this.observerSocket = undefined;
    if (socket && socket.readyState !== 3) {
      try {
        socket.close(1000, "observer stopped");
      } catch {
        // ignore close races
      }
    }
    this.setObserverStatus({ state: "stopped" });
  }

  /**
   * Abort in-flight HTTP and tear down the observer. Irreversible for this instance.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopObserver();
    this.stopPresence();
    this.rootController.abort();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private ensureOpen(): void {
    if (this.disposed || this.rootController.signal.aborted) {
      throw new CollaborationClientError({
        kind: "aborted",
        code: "collaboration_disposed",
        message: "CollaborationClient has been disposed."
      });
    }
  }

  private async applyAuth(headers: Record<string, string>): Promise<void> {
    const token = await this.options.credential.getDeviceToken();
    if (!token) {
      throw new CollaborationClientError({
        kind: "auth",
        code: "collaboration_credential_missing",
        message: "Human device credential is not available."
      });
    }
    headers.authorization = `Bearer ${token}`;
  }

  private async jsonEmpty(
    method: JsonMethod,
    path: string,
    options: { body?: unknown; auth?: boolean; signal?: AbortSignal }
  ): Promise<void> {
    await this.json(method, path, undefined, options);
  }

  private async json<T>(
    method: JsonMethod,
    path: string,
    schema: ZodType<T> | undefined,
    options: { body?: unknown; auth?: boolean; signal?: AbortSignal; acceptedStatus?: number }
  ): Promise<T> {
    this.ensureOpen();
    const headers: Record<string, string> = {
      accept: "application/json"
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json; charset=utf-8";
    }
    if (options.auth !== false) {
      await this.applyAuth(headers);
    }
    const response = await this.send(path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal
    });
    const text = await this.readTextLimited(response);
    if (!response.ok && response.status !== options.acceptedStatus) {
      throw collaborationErrorFromHttp(response.status, text);
    }
    if (schema === undefined) {
      if (text.length === 0) return undefined as T;
      // Some membership mutations return empty or opaque ack bodies.
      try {
        JSON.parse(text);
      } catch {
        throw new CollaborationClientError({
          kind: "protocol",
          code: "collaboration_malformed_json",
          message: "Response was not valid JSON."
        });
      }
      return undefined as T;
    }
    let value: unknown;
    try {
      value = text.length === 0 ? null : JSON.parse(text);
    } catch {
      throw new CollaborationClientError({
        kind: "protocol",
        code: "collaboration_malformed_json",
        message: "Response was not valid JSON."
      });
    }
    try {
      const parsed = schema.parse(value);
      assertHumanDisplayDtoRedacted(parsed);
      return parsed;
    } catch (error) {
      throw new CollaborationClientError({
        kind: "protocol",
        code: "collaboration_response_invalid",
        message: "Response failed contract validation.",
        cause: error
      });
    }
  }

  private async send(
    path: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body?: string | Uint8Array;
      signal?: AbortSignal;
    }
  ): Promise<Response> {
    const url = new URL(path, this.profile.serverBaseUrl);
    const timeout = new AbortController();
    const timer = this.clock.setTimeout(() => timeout.abort(), this.limits.requestTimeoutMs);
    const signals = [this.rootController.signal, timeout.signal];
    if (init.signal) signals.push(init.signal);
    const signal = AbortSignal.any(signals);
    try {
      const body: BodyInit | undefined =
        init.body === undefined
          ? undefined
          : typeof init.body === "string"
            ? init.body
            : Buffer.from(init.body);
      return await this.fetchImpl(url, {
        method: init.method,
        headers: init.headers,
        body,
        signal
      });
    } catch (error) {
      if (signal.aborted && timeout.signal.aborted && !this.rootController.signal.aborted) {
        throw new CollaborationClientError({
          kind: "timeout",
          code: "collaboration_timeout",
          message: "Collaboration request timed out.",
          retryable: true,
          cause: error
        });
      }
      throw collaborationErrorFromUnknown(error);
    } finally {
      this.clock.clearTimeout(timer);
    }
  }

  private async readTextLimited(response: Response): Promise<string> {
    const declared = response.headers.get("content-length");
    if (declared && /^\d+$/.test(declared) && Number(declared) > this.limits.jsonBodyMaxBytes) {
      throw new CollaborationClientError({
        kind: "payload_too_large",
        code: "collaboration_response_too_large",
        message: "Response exceeded body size limit.",
        httpStatus: response.status
      });
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > this.limits.jsonBodyMaxBytes) {
      throw new CollaborationClientError({
        kind: "payload_too_large",
        code: "collaboration_response_too_large",
        message: "Response exceeded body size limit.",
        httpStatus: response.status
      });
    }
    return Buffer.from(buffer).toString("utf8");
  }

  private connectObserver(): void {
    if (!this.observerWanted || this.disposed) return;
    const WebSocketImpl = this.options.WebSocketImpl;
    if (!WebSocketImpl) return;

    this.setObserverStatus({
      state: "connecting",
      attempt: this.observerReconnectAttempt + 1
    });

    void (async () => {
      try {
        const token = await this.options.credential.getDeviceToken();
        if (!token) {
          this.setObserverStatus({
            state: "auth_expired",
            code: "collaboration_credential_missing"
          });
          this.observerWanted = false;
          return;
        }
        const base = new URL(this.profile.serverBaseUrl);
        const wsUrl = new URL(base.origin);
        wsUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";
        wsUrl.pathname = `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/human/observe`;

        const socket = new WebSocketImpl(wsUrl.toString(), {
          headers: { Authorization: `Bearer ${token}` }
        });
        this.observerSocket = socket;

        const onOpen = () => {
          const hello = humanObserverHelloSchema.parse({
            type: "human.observer.hello",
            protocolVersion: HUMAN_OBSERVER_PROTOCOL_VERSION,
            projectId: this.profile.projectId,
            lastCursor: this.observerCursor
          });
          socket.send(JSON.stringify(hello));
        };

        const onMessage = (event: unknown) => {
          try {
            const data =
              typeof event === "object" && event !== null && "data" in event
                ? (event as { data: unknown }).data
                : event;
            if (
              typeof data !== "string" &&
              !(data instanceof ArrayBuffer) &&
              !ArrayBuffer.isView(data)
            ) {
              throw new CollaborationClientError({
                kind: "protocol",
                code: "collaboration_observer_payload_type",
                message: "Observer payload must be text."
              });
            }
            const text =
              typeof data === "string"
                ? data
                : Buffer.from(
                    data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer,
                    data instanceof ArrayBuffer ? 0 : (data as ArrayBufferView).byteOffset,
                    data instanceof ArrayBuffer
                      ? data.byteLength
                      : (data as ArrayBufferView).byteLength
                  ).toString("utf8");
            if (Buffer.byteLength(text, "utf8") > this.limits.observerMaxPayloadBytes) {
              throw new CollaborationClientError({
                kind: "payload_too_large",
                code: "collaboration_observer_payload_too_large",
                message: "Observer payload exceeded size limit."
              });
            }
            const message = parseHumanObserverServerMessage(JSON.parse(text));
            this.handleObserverMessage(message);
          } catch (error) {
            this.options.logger?.error?.(
              redactCollaborationText(
                error instanceof Error ? error.message : "observer message failed"
              )
            );
            try {
              socket.close(4000, "protocol error");
            } catch {
              // ignore
            }
          }
        };

        const onClose = () => {
          this.observerSocket = undefined;
          if (this.observerStatus.state === "auth_expired") return;
          if (!this.observerWanted || this.disposed) {
            this.setObserverStatus({ state: "stopped" });
            return;
          }
          this.scheduleObserverReconnect();
        };

        const onError = () => {
          this.options.logger?.warn?.("collaboration observer socket error");
        };

        socket.addEventListener("open", onOpen);
        socket.addEventListener("message", onMessage);
        socket.addEventListener("close", onClose);
        socket.addEventListener("error", onError);
      } catch (error) {
        this.options.logger?.error?.(
          redactCollaborationText(
            error instanceof Error ? error.message : "observer connect failed"
          )
        );
        if (this.observerWanted && !this.disposed) this.scheduleObserverReconnect();
      }
    })();
  }

  private handleObserverMessage(message: HumanObserverServerMessage): void {
    switch (message.type) {
      case "human.observer.welcome":
        this.observerCursor = message.cursor;
        this.observerReconnectAttempt = 0;
        this.setObserverStatus({
          state: "connected",
          cursor: message.cursor,
          connectedAt: this.clock.now().toISOString()
        });
        break;
      case "human.observer.event":
        if (message.previousCursor !== this.observerCursor) {
          throw new CollaborationClientError({
            kind: "protocol",
            code: "collaboration_observer_cursor_gap",
            message: "Observer event did not continue from the last validated cursor."
          });
        }
        this.observerCursor = message.cursor;
        this.observerHandlers?.onEvent?.(message);
        break;
      case "human.observer.catchup_required":
        this.observerCursor = message.resumeCursor;
        this.setObserverStatus({
          state: "catching_up",
          resumeCursor: message.resumeCursor
        });
        this.observerHandlers?.onCatchupRequired?.(message);
        break;
      case "human.observer.auth_expired":
        this.observerWanted = false;
        this.setObserverStatus({ state: "auth_expired", code: message.code });
        this.observerHandlers?.onAuthExpired?.(message);
        try {
          this.observerSocket?.close(4001, "auth expired");
        } catch {
          // ignore
        }
        break;
      case "human.observer.pong":
        break;
      default: {
        const _exhaustive: never = message;
        void _exhaustive;
      }
    }
  }

  private scheduleObserverReconnect(): void {
    if (!this.observerWanted || this.disposed) return;
    this.observerReconnectAttempt += 1;
    const delayMs = reconnectDelay(this.observerReconnectAttempt, this.random, {
      initialDelayMs: this.limits.reconnectInitialDelayMs,
      maxDelayMs: this.limits.reconnectMaxDelayMs
    });
    this.setObserverStatus({
      state: "reconnecting",
      attempt: this.observerReconnectAttempt,
      delayMs
    });
    if (this.observerReconnectTimer) this.clock.clearTimeout(this.observerReconnectTimer);
    this.observerReconnectTimer = this.clock.setTimeout(() => {
      this.observerReconnectTimer = undefined;
      this.connectObserver();
    }, delayMs);
  }

  private setObserverStatus(status: CollaborationObserverStatus): void {
    this.observerStatus = status;
    this.observerHandlers?.onStatus?.(status);
  }
}
