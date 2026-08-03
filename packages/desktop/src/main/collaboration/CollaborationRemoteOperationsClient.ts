import {
  remoteActionViewSchema,
  remoteDispatchIntentSchema,
  remoteDispatchIntentV3Schema,
  remoteDispatchWireCommandSchema,
  remoteEventQuerySchema,
  remoteEventReplaySchema,
  remoteHumanExecutionActionCommandSchema,
  remoteInteractionPageQuerySchema,
  remoteInteractionPageSchema,
  remoteInteractionResponseSchema,
  remoteInteractionViewSchema,
  remoteEndpointOperationObservationSchema,
  remoteOperationObservationSchema,
  type RemoteActionView,
  type RemoteDispatchIntent,
  type RemoteDispatchIntentV3,
  type RemoteDispatchWireCommand,
  type RemoteEventReplay,
  type RemoteHumanExecutionActionCommand,
  type RemoteInteractionPage,
  type RemoteInteractionResponse,
  type RemoteInteractionView,
  type RemoteOperationObservation
} from "@planweave-ai/collaboration-protocol/remote-run";
import {
  remoteAgentEndpointListSchema,
  type RemoteAgentEndpointList
} from "@planweave-ai/collaboration-protocol/agent-endpoint";
import type { z, ZodType } from "zod";
import type { JsonMethod } from "./collaborationHttpTransport.js";

export interface CollaborationRemoteOperationsTransportPort {
  json<T>(
    method: JsonMethod,
    path: string,
    schema: ZodType<T>,
    options: { body?: unknown; signal?: AbortSignal }
  ): Promise<T>;
}

export interface CollaborationRemoteOperationsPort {
  listAgentEndpoints(signal?: AbortSignal): Promise<RemoteAgentEndpointList>;
  dispatchRemoteOperation(
    command: RemoteDispatchIntent | RemoteDispatchIntentV3 | RemoteDispatchWireCommand,
    signal?: AbortSignal
  ): Promise<RemoteOperationObservation>;
  observeRemoteOperation(
    operationId: string,
    signal?: AbortSignal
  ): Promise<RemoteOperationObservation>;
  executeRemoteOperationAction(
    operationId: string,
    action: RemoteHumanExecutionActionCommand,
    signal?: AbortSignal
  ): Promise<RemoteActionView>;
  replayRemoteOperationEvents(
    operationId: string,
    query?: z.input<typeof remoteEventQuerySchema>,
    signal?: AbortSignal
  ): Promise<RemoteEventReplay>;
  listRemoteOperationInteractions(
    operationId: string,
    query?: z.input<typeof remoteInteractionPageQuerySchema>,
    signal?: AbortSignal
  ): Promise<RemoteInteractionPage>;
  settleRemoteOperationInteraction(
    operationId: string,
    settlement: RemoteInteractionResponse,
    signal?: AbortSignal
  ): Promise<RemoteInteractionView>;
}

export class CollaborationRemoteOperationsClient implements CollaborationRemoteOperationsPort {
  constructor(
    private readonly projectId: string,
    private readonly transport: CollaborationRemoteOperationsTransportPort
  ) {}

  listAgentEndpoints(signal?: AbortSignal): Promise<RemoteAgentEndpointList> {
    return this.transport.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/agent-endpoints`,
      remoteAgentEndpointListSchema,
      { signal }
    );
  }

  dispatchRemoteOperation(
    command: RemoteDispatchIntent | RemoteDispatchIntentV3 | RemoteDispatchWireCommand,
    signal?: AbortSignal
  ): Promise<RemoteOperationObservation> {
    const body =
      "schemaVersion" in command
        ? command.schemaVersion === "remote-run/v3"
          ? remoteDispatchIntentV3Schema.parse(command)
          : remoteDispatchIntentSchema.parse(command)
        : remoteDispatchWireCommandSchema.parse(command);
    const responseSchema =
      "schemaVersion" in body && body.schemaVersion === "remote-run/v3"
        ? remoteEndpointOperationObservationSchema
        : remoteOperationObservationSchema;
    return this.transport.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/remote-operations`,
      responseSchema,
      { body, signal }
    );
  }

  observeRemoteOperation(
    operationId: string,
    signal?: AbortSignal
  ): Promise<RemoteOperationObservation> {
    return this.transport.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/remote-operations/${encodeURIComponent(operationId)}`,
      remoteOperationObservationSchema,
      { signal }
    );
  }

  executeRemoteOperationAction(
    operationId: string,
    action: RemoteHumanExecutionActionCommand,
    signal?: AbortSignal
  ): Promise<RemoteActionView> {
    return this.transport.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/remote-operations/${encodeURIComponent(operationId)}/actions`,
      remoteActionViewSchema,
      { body: remoteHumanExecutionActionCommandSchema.parse(action), signal }
    );
  }

  replayRemoteOperationEvents(
    operationId: string,
    query: z.input<typeof remoteEventQuerySchema> = {},
    signal?: AbortSignal
  ): Promise<RemoteEventReplay> {
    const parsed = remoteEventQuerySchema.parse(query);
    const params = new URLSearchParams({ afterCursor: String(parsed.afterCursor) });
    return this.transport.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/remote-operations/${encodeURIComponent(operationId)}/events?${params}`,
      remoteEventReplaySchema,
      { signal }
    );
  }

  listRemoteOperationInteractions(
    operationId: string,
    query: z.input<typeof remoteInteractionPageQuerySchema> = {},
    signal?: AbortSignal
  ): Promise<RemoteInteractionPage> {
    const parsed = remoteInteractionPageQuerySchema.parse(query);
    const params = new URLSearchParams({
      cursor: String(parsed.cursor),
      limit: String(parsed.limit)
    });
    return this.transport.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/remote-operations/${encodeURIComponent(operationId)}/interactions?${params}`,
      remoteInteractionPageSchema,
      { signal }
    );
  }

  settleRemoteOperationInteraction(
    operationId: string,
    settlement: RemoteInteractionResponse,
    signal?: AbortSignal
  ): Promise<RemoteInteractionView> {
    return this.transport.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/remote-operations/${encodeURIComponent(operationId)}/interactions/respond`,
      remoteInteractionViewSchema,
      { body: remoteInteractionResponseSchema.parse(settlement), signal }
    );
  }
}
