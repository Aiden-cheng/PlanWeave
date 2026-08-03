import { opaqueIdentifierSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  remoteDispatchIntentSchema,
  remoteDispatchIntentV3Schema,
  remoteDispatchWireCommandSchema,
  remoteEventQuerySchema,
  remoteInteractionPageQuerySchema,
  type RemoteActionView,
  type RemoteEventReplay,
  type RemoteInteractionPage,
  type RemoteInteractionView,
  type RemoteOperationObservation
} from "@planweave-ai/collaboration-protocol/remote-run";
import type { RemoteAgentEndpointList } from "@planweave-ai/collaboration-protocol/agent-endpoint";
import { z } from "zod";
import {
  collaborationRemoteActionInputSchema,
  collaborationRemoteInteractionRespondInputSchema,
  collaborationRemoteOperationIdInputSchema
} from "../../shared/collaborationReadModels.js";
import type { CollaborationRemoteOperationsPort } from "./CollaborationRemoteOperationsClient.js";
import { CollaborationClientError } from "./collaborationErrors.js";

/**
 * Service-facing seam for remote-run dispatch/observe/action paths.
 * Keeps durable remote execution orchestration out of the profile/session service body.
 */
export class CollaborationRemoteOperationsFacade {
  constructor(
    private readonly withActiveClient: <T>(
      operation: (client: CollaborationRemoteOperationsPort) => Promise<T>
    ) => Promise<T>
  ) {}

  async listAgentEndpoints(): Promise<RemoteAgentEndpointList> {
    return this.withActiveClient((client) => client.listAgentEndpoints());
  }

  async dispatch(input: unknown): Promise<RemoteOperationObservation> {
    const command =
      input &&
      typeof input === "object" &&
      "schemaVersion" in input &&
      (input as { schemaVersion?: string }).schemaVersion === "remote-run/v3"
        ? remoteDispatchIntentV3Schema.parse(input)
        : input &&
            typeof input === "object" &&
            "schemaVersion" in input &&
            (input as { schemaVersion?: string }).schemaVersion === "remote-run/v2"
          ? remoteDispatchIntentSchema.parse(input)
          : remoteDispatchWireCommandSchema.parse(input);
    return this.withActiveClient((client) => client.dispatchRemoteOperation(command));
  }

  async observe(input: unknown): Promise<RemoteOperationObservation> {
    const { operationId } = collaborationRemoteOperationIdInputSchema.parse(input);
    return this.withActiveClient((client) => client.observeRemoteOperation(operationId));
  }

  async executeAction(input: unknown): Promise<RemoteActionView> {
    const { operationId, action } = collaborationRemoteActionInputSchema.parse(input);
    return this.withActiveClient((client) =>
      client.executeRemoteOperationAction(operationId, action)
    );
  }

  async replayEvents(input: unknown): Promise<RemoteEventReplay> {
    const parsed = z
      .object({
        operationId: opaqueIdentifierSchema,
        query: remoteEventQuerySchema.optional()
      })
      .strict()
      .parse(input);
    return this.withActiveClient((client) =>
      client.replayRemoteOperationEvents(parsed.operationId, parsed.query ?? {})
    );
  }

  async listInteractions(input: unknown): Promise<RemoteInteractionPage> {
    const parsed = z
      .object({
        operationId: opaqueIdentifierSchema,
        query: remoteInteractionPageQuerySchema.optional()
      })
      .strict()
      .parse(input);
    return this.withActiveClient((client) =>
      client.listRemoteOperationInteractions(parsed.operationId, parsed.query ?? {})
    );
  }

  async settleInteraction(input: unknown): Promise<RemoteInteractionView> {
    const { operationId, settlement } =
      collaborationRemoteInteractionRespondInputSchema.parse(input);
    return this.withActiveClient((client) =>
      client.settleRemoteOperationInteraction(operationId, settlement)
    );
  }
}

export function requireActiveCollaborationClient(
  client: CollaborationRemoteOperationsPort | null,
  clientProfileId: string | null
): CollaborationRemoteOperationsPort {
  if (!client || !clientProfileId) {
    throw new CollaborationClientError({
      kind: "offline",
      code: "collaboration_session_inactive",
      message: "No active collaboration session. Connect a profile before loading read models.",
      retryable: false
    });
  }
  return client;
}
