import {
  remoteAgentEndpointListSchema,
  type RemoteAgentEndpointList
} from "@planweave-ai/collaboration-protocol/agent-endpoint";
import type { OperatorControlClient } from "./OperatorControlClient.js";

/** Server-scoped Owner Fleet endpoint directory (GET /api/v1/agent-endpoints). */
export type FleetEndpointSource = {
  listEndpoints(): Promise<RemoteAgentEndpointList>;
};

export function createOperatorFleetEndpointSource(
  client: OperatorControlClient
): FleetEndpointSource {
  return {
    listEndpoints: () => client.listAgentEndpoints()
  };
}

export function parseFleetEndpointList(value: unknown): RemoteAgentEndpointList {
  return remoteAgentEndpointListSchema.parse(value);
}
