import {
  accessMutationRequestSchema,
  accessMutationResultSchema,
  activityListPageSchema,
  activityListWireQuerySchema,
  assignmentDisplayProjectionSchema,
  assignmentListPageSchema,
  assignmentListQuerySchema,
  assignmentUpdateWireCommandSchema,
  commentCreateWireCommandSchema,
  commentDisplayProjectionSchema,
  commentEditWireCommandSchema,
  commentListPageSchema,
  commentListWireQuerySchema,
  commentTombstoneWireCommandSchema,
  createPendingAttachmentRequestSchema,
  eligibleAssigneesResponseSchema,
  executionTargetReadModelSchema,
  executionTargetUpdateWireCommandSchema,
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
  humanRevokeInvitationsRequestSchema,
  humanRevokeInvitationsResponseSchema,
  humanMemberPageSchema,
  humanObserverHelloSchema,
  humanPageQuerySchema,
  HUMAN_OBSERVER_PROTOCOL_VERSION,
  parseHumanObserverServerMessage,
  pendingAttachmentViewSchema,
  remoteActionViewSchema,
  remoteDispatchIntentSchema,
  remoteDispatchWireCommandSchema,
  remoteEventQuerySchema,
  remoteEventReplaySchema,
  remoteHumanExecutionActionCommandSchema,
  remoteInteractionPageQuerySchema,
  remoteInteractionPageSchema,
  remoteInteractionResponseSchema,
  remoteInteractionViewSchema,
  remoteOperationObservationSchema,
  responsibilityReadModelSchema,
  responsibilityUpdateWireCommandSchema,
  reviewAssignmentReadModelSchema,
  reviewAssignmentUpdateWireCommandSchema,
  uploadPendingAttachmentResponseSchema,
  workAuthorityProjectionSchema,
  authoritativeContentVersionSchema,
  contentVersionAcknowledgementSchema,
  contentVersionAuthorityDiscoveryResultSchema,
  firstContentVersionPublishResultSchema,
  currentCanvasAccessViewSchema,
  canvasRuntimeStatusProjectionSchema,
  type ActivityListPage,
  type AssignmentDisplayProjection,
  type AssignmentListPage,
  type AssignmentUpdateWireCommand,
  type CanvasCommandOutcome,
  type CollaborationWorkScope,
  type ExecutionTargetReadModel,
  type ExecutionTargetUpdateWireCommand,
  type CanvasPresencePointer,
  type CanvasPresenceSelectionId,
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
  type HumanRevokeInvitationsResponse,
  type HumanMemberPage,
  type HumanObserverCursor,
  type HumanObserverServerMessage,
  type PendingAttachmentView,
  type RemoteActionView,
  type RemoteDispatchIntent,
  type RemoteDispatchWireCommand,
  type RemoteEventReplay,
  type RemoteHumanExecutionActionCommand,
  type RemoteInteractionPage,
  type RemoteInteractionResponse,
  type RemoteInteractionView,
  type RemoteOperationObservation,
  type ResponsibilityReadModel,
  type ResponsibilityUpdateWireCommand,
  type ReviewAssignmentReadModel,
  type ReviewAssignmentUpdateWireCommand,
  type WorkAuthorityProjection,
  type WorkItemRef,
  type AuthoritativeContentVersion,
  type CompleteContentVersion,
  type CompletedContentVersionRef,
  type ContentVersionAcknowledgement,
  type ContentVersionAuthorityDiscoveryResult,
  type FirstContentVersionPublishResult,
  type AccessMutationResult,
  type CurrentCanvasAccessView,
  type CanvasRuntimeStatusProjection
} from "@planweave-ai/collaboration-contracts";
import type { z, ZodType } from "zod";
import { CollaborationClientError, collaborationErrorFromHttp } from "./collaborationErrors.js";
import { reconnectDelay } from "./reconnectBackoff.js";
import { redactCollaborationText } from "./redaction.js";
import { derivedWebSocketOrigin } from "./webSocketOrigin.js";
import { CanvasPresenceClient } from "./CanvasPresenceClient.js";
import { CollaborationRegistryClient } from "./CollaborationRegistryClient.js";
import type {
  CollaborationClientClock,
  CollaborationCredentialPort,
  CollaborationObserverHandlers,
  CollaborationObserverStatus,
  CollaborationPresenceHandlers,
  CollaborationPresenceStatus,
  CollaborationWebSocketConstructor,
  CollaborationWebSocketLike
} from "./collaborationClientTypes.js";
import { systemCollaborationClock } from "./collaborationClientTypes.js";
import { CollaborationHttpTransport } from "./collaborationHttpTransport.js";
import {
  CanvasCommandClient,
  type CanvasCommandMaterializationHooks,
  type CanvasCommandReconnectInput,
  type CanvasCommandSubmitInput
} from "./CanvasCommandClient.js";
import type { CanvasCommandSessionSnapshot } from "./canvasCommandSession.js";

export type {
  CollaborationClientClock,
  CollaborationCredentialPort,
  CollaborationObserverHandlers,
  CollaborationObserverStatus,
  CollaborationPresenceHandlers,
  CollaborationPresenceStatus,
  CollaborationWebSocketConstructor,
  CollaborationWebSocketLike
} from "./collaborationClientTypes.js";

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

/**
 * Electron-main human collaboration client.
 *
 * Application-shaped methods only — no raw `request(path)` or socket access for callers.
 * Validates every JSON response/event with collaboration-contracts Zod schemas.
 */
export class CollaborationClient {
  private readonly transport: CollaborationHttpTransport;
  private readonly clock: CollaborationClientClock;
  private readonly random: () => number;
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
  private readonly canvasCommands: CanvasCommandClient;

  constructor(private readonly options: CollaborationClientOptions) {
    this.transport = new CollaborationHttpTransport({
      serverBaseUrl: options.profile.serverBaseUrl,
      credential: options.credential,
      limits: options.limits,
      request: options.request,
      clock: options.clock
    });
    this.clock = options.clock ?? systemCollaborationClock;
    this.random = options.random ?? Math.random;
    this.presence = new CanvasPresenceClient({
      profile: options.profile,
      credential: options.credential,
      WebSocketImpl: options.WebSocketImpl,
      clock: this.clock,
      random: this.random,
      reconnectInitialDelayMs: this.transport.limits.reconnectInitialDelayMs,
      reconnectMaxDelayMs: this.transport.limits.reconnectMaxDelayMs,
      logger: options.logger
    });
    this.registryClient = new CollaborationRegistryClient((method, path, schema, requestOptions) =>
      this.transport.json(method, path, schema, {
        ...requestOptions,
        auth: true
      })
    );
    this.canvasCommands = new CanvasCommandClient(this.transport, options.profile.projectId);
  }

  get projectId(): string {
    return this.options.profile.projectId;
  }

  get connectionProfile(): CollaborationConnectionProfile {
    return this.options.profile;
  }

  private get profile(): CollaborationConnectionProfile {
    return this.options.profile;
  }

  private get limits(): CollaborationClientLimits {
    return this.transport.limits;
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

  async revokeInvitations(
    input: z.input<typeof humanRevokeInvitationsRequestSchema>,
    signal?: AbortSignal
  ): Promise<HumanRevokeInvitationsResponse> {
    const body = humanRevokeInvitationsRequestSchema.parse(input);
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/human/invitations/revoke-batch`,
      humanRevokeInvitationsResponseSchema,
      { body, signal }
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

  async verifyAccess(signal?: AbortSignal): Promise<void> {
    await this.listMembers({ cursor: 0, limit: 1 }, signal);
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
  // Separated responsibility / reviewer / execution-target authorities (OSS-003)
  // ---------------------------------------------------------------------------

  async getWorkAuthority(
    scope: CollaborationWorkScope,
    signal?: AbortSignal
  ): Promise<WorkAuthorityProjection> {
    const params = new URLSearchParams({ scope: JSON.stringify(scope) });
    return this.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/assignments/authority?${params}`,
      workAuthorityProjectionSchema,
      { signal }
    );
  }

  async getResponsibility(
    scope: CollaborationWorkScope,
    signal?: AbortSignal
  ): Promise<ResponsibilityReadModel | null> {
    const params = new URLSearchParams({ scope: JSON.stringify(scope) });
    return this.jsonNullable(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/assignments/responsibility?${params}`,
      responsibilityReadModelSchema,
      { signal }
    );
  }

  async updateResponsibility(
    command: ResponsibilityUpdateWireCommand,
    signal?: AbortSignal
  ): Promise<ResponsibilityReadModel> {
    const body = responsibilityUpdateWireCommandSchema.parse(command);
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/assignments/responsibility`,
      responsibilityReadModelSchema,
      { body, signal }
    );
  }

  async getReviewer(
    scope: CollaborationWorkScope,
    signal?: AbortSignal
  ): Promise<ReviewAssignmentReadModel | null> {
    const params = new URLSearchParams({ scope: JSON.stringify(scope) });
    return this.jsonNullable(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/assignments/reviewer?${params}`,
      reviewAssignmentReadModelSchema,
      { signal }
    );
  }

  async updateReviewer(
    command: ReviewAssignmentUpdateWireCommand,
    signal?: AbortSignal
  ): Promise<ReviewAssignmentReadModel> {
    const body = reviewAssignmentUpdateWireCommandSchema.parse(command);
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/assignments/reviewer`,
      reviewAssignmentReadModelSchema,
      { body, signal }
    );
  }

  async getExecutionTarget(
    scope: CollaborationWorkScope,
    signal?: AbortSignal
  ): Promise<ExecutionTargetReadModel | null> {
    const params = new URLSearchParams({ scope: JSON.stringify(scope) });
    return this.jsonNullable(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/assignments/execution-target?${params}`,
      executionTargetReadModelSchema,
      { signal }
    );
  }

  async updateExecutionTarget(
    command: ExecutionTargetUpdateWireCommand,
    signal?: AbortSignal
  ): Promise<ExecutionTargetReadModel> {
    const body = executionTargetUpdateWireCommandSchema.parse(command);
    return this.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.profile.projectId)}/assignments/execution-target`,
      executionTargetReadModelSchema,
      { body, signal }
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
    command: RemoteDispatchIntent | RemoteDispatchWireCommand,
    signal?: AbortSignal
  ): Promise<RemoteOperationObservation> {
    const body =
      "schemaVersion" in command && command.schemaVersion === "remote-run/v2"
        ? remoteDispatchIntentSchema.parse(command)
        : remoteDispatchWireCommandSchema.parse(command);
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
    await this.transport.applyAuth(headers);
    const response = await this.transport.send(path, {
      method: "PUT",
      headers,
      body: input.body,
      signal
    });
    // Reuse transport JSON body budget via a raw send + manual size check path.
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > this.limits.jsonBodyMaxBytes) {
      throw new CollaborationClientError({
        kind: "payload_too_large",
        code: "collaboration_response_too_large",
        message: "Response exceeded body size limit.",
        httpStatus: response.status
      });
    }
    const text = Buffer.from(buffer).toString("utf8");
    if (!response.ok) {
      throw collaborationErrorFromHttp(response.status, text, response.headers.get("retry-after"));
    }
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
  // Server-authoritative canvas commands (durable; not presence)
  // ---------------------------------------------------------------------------

  canvasCommandSession(): CanvasCommandSessionSnapshot | null {
    return this.canvasCommands.sessionSnapshot();
  }

  bindCanvasCommandSession(canvasId: string): void {
    this.ensureOpen();
    this.canvasCommands.bindCanvas(canvasId);
  }

  async submitCanvasCommand(
    input: CanvasCommandSubmitInput,
    signal?: AbortSignal,
    hooks?: CanvasCommandMaterializationHooks
  ): Promise<CanvasCommandOutcome> {
    this.ensureOpen();
    return this.canvasCommands.submit(input, signal, hooks);
  }

  async reconnectCanvasCommands(
    input: CanvasCommandReconnectInput,
    signal?: AbortSignal,
    hooks?: CanvasCommandMaterializationHooks
  ): Promise<ReturnType<CanvasCommandClient["reconnect"]>> {
    this.ensureOpen();
    return this.canvasCommands.reconnect(input, signal, hooks);
  }

  /** Read the authoritative access view for one canvas through the device-authenticated transport. */
  async getCurrentCanvasAccess(canvasId: string): Promise<CurrentCanvasAccessView> {
    return this.transport.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/canvases/${encodeURIComponent(canvasId)}/access`,
      currentCanvasAccessViewSchema
    );
  }

  /** Apply one CAS-protected ACL mutation against the current-canvas endpoint. */
  async mutateCurrentCanvasAccess(input: {
    canvasId: string;
    request: unknown;
  }): Promise<AccessMutationResult> {
    const body = accessMutationRequestSchema.parse(input.request);
    return this.transport.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/canvases/${encodeURIComponent(input.canvasId)}/access`,
      accessMutationResultSchema,
      { body, acceptedStatus: [403, 409] }
    );
  }

  async discoverContentAuthority(input: {
    canvasId: string;
    localReplica: CompletedContentVersionRef | null;
    knownRevision: number | null;
  }): Promise<ContentVersionAuthorityDiscoveryResult> {
    return this.transport.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/canvases/${encodeURIComponent(input.canvasId)}/content/head`,
      contentVersionAuthorityDiscoveryResultSchema,
      { body: input }
    );
  }

  async publishInitialContent(input: {
    canvasId: string;
    content: CompleteContentVersion;
  }): Promise<FirstContentVersionPublishResult> {
    return this.transport.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/canvases/${encodeURIComponent(input.canvasId)}/content/initial-publish`,
      firstContentVersionPublishResultSchema,
      {
        body: {
          expectedHeadRevision: 0,
          expectedHeadVersionId: null,
          content: input.content
        },
        acceptedStatus: 409
      }
    );
  }

  async fetchContentVersion(input: {
    canvasId: string;
    content: CompletedContentVersionRef;
  }): Promise<AuthoritativeContentVersion> {
    return this.transport.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/canvases/${encodeURIComponent(input.canvasId)}/content/fetch`,
      authoritativeContentVersionSchema,
      { body: { content: input.content } }
    );
  }

  async acknowledgeContentVersion(input: {
    canvasId: string;
    content: CompletedContentVersionRef;
  }): Promise<ContentVersionAcknowledgement> {
    return this.transport.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/canvases/${encodeURIComponent(input.canvasId)}/content/acknowledgements`,
      contentVersionAcknowledgementSchema,
      { body: { content: input.content } }
    );
  }

  async readRuntimeStatus(
    canvasId: string,
    signal?: AbortSignal
  ): Promise<CanvasRuntimeStatusProjection> {
    return this.transport.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/canvases/${encodeURIComponent(canvasId)}/runtime-status`,
      canvasRuntimeStatusProjectionSchema,
      { signal }
    );
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
    this.canvasCommands.clearSession();
    this.transport.dispose();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private ensureOpen(): void {
    if (this.disposed) {
      throw new CollaborationClientError({
        kind: "aborted",
        code: "collaboration_disposed",
        message: "CollaborationClient has been disposed."
      });
    }
    this.transport.ensureOpen();
  }

  private async jsonEmpty(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    options: { body?: unknown; auth?: boolean; signal?: AbortSignal }
  ): Promise<void> {
    await this.transport.jsonEmpty(method, path, options);
  }

  private async json<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    schema: ZodType<T> | undefined,
    options: {
      body?: unknown;
      auth?: boolean;
      signal?: AbortSignal;
      acceptedStatus?: number | number[];
    }
  ): Promise<T> {
    return this.transport.json(method, path, schema, options);
  }

  private async jsonNullable<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    schema: ZodType<T>,
    options: { body?: unknown; auth?: boolean; signal?: AbortSignal }
  ): Promise<T | null> {
    return this.transport.jsonNullable(method, path, schema, options);
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
          headers: {
            Authorization: `Bearer ${token}`,
            Origin: derivedWebSocketOrigin(this.profile.serverBaseUrl)
          }
        });
        this.observerSocket = socket;

        socket.on?.("unexpected-response", (_request, response) => {
          if (this.observerSocket !== socket) return;
          response.resume?.();
          const statusCode = response.statusCode;
          const code =
            statusCode === undefined
              ? "collaboration_observer_handshake_rejected"
              : `collaboration_observer_http_${statusCode}`;
          this.observerWanted = false;
          this.setObserverStatus(
            statusCode === 401
              ? { state: "auth_expired", code }
              : { state: "failed", code }
          );
        });

        const onOpen = () => {
          if (this.observerSocket !== socket) return;
          const hello = humanObserverHelloSchema.parse({
            type: "human.observer.hello",
            protocolVersion: HUMAN_OBSERVER_PROTOCOL_VERSION,
            projectId: this.profile.projectId,
            lastCursor: this.observerCursor
          });
          socket.send(JSON.stringify(hello));
        };

        const onMessage = (event: unknown) => {
          if (this.observerSocket !== socket) return;
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
          if (this.observerSocket !== socket) return;
          this.observerSocket = undefined;
          if (
            this.observerStatus.state === "auth_expired" ||
            this.observerStatus.state === "failed"
          ) {
            return;
          }
          if (!this.observerWanted || this.disposed) {
            this.setObserverStatus({ state: "stopped" });
            return;
          }
          this.scheduleObserverReconnect();
        };

        const onError = () => {
          if (this.observerSocket !== socket) return;
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
