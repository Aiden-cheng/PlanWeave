import {
  capabilitiesSchema,
  hostAcpProfileObservationSchema,
  opaqueIdentifierSchema
} from "@planweave-ai/agent-host-protocol";
import { z } from "zod";

export const agentEndpointUnavailableReasonSchema = z.enum([
  "host_offline",
  "host_revoked",
  "host_credential_expired",
  "workspace_mapping_missing",
  "workspace_mapping_invalid",
  "profile_missing",
  "profile_invalid",
  "at_capacity"
]);

const agentProfileDescriptorSchema = hostAcpProfileObservationSchema.pick({
  profileId: true,
  agentId: true,
  displayName: true,
  capabilities: true
});

const agentEndpointBaseSchema = agentProfileDescriptorSchema.extend({
  schemaVersion: z.literal("agent-endpoint/v1"),
  endpointId: opaqueIdentifierSchema,
  hostDisplayName: hostAcpProfileObservationSchema.shape.displayName
});

export const availableRemoteAgentEndpointSchema = agentEndpointBaseSchema.extend({
  status: z.literal("available")
});

const unavailableAgentEndpointSchema = agentEndpointBaseSchema.extend({
  status: z.literal("unavailable"),
  unavailableReason: agentEndpointUnavailableReasonSchema
});

/** Strict, redacted human-visible projection of one exact Host ACP profile. */
export const remoteAgentEndpointSchema = z.discriminatedUnion("status", [
  availableRemoteAgentEndpointSchema,
  unavailableAgentEndpointSchema
]);

export const remoteAgentEndpointListSchema = z
  .object({
    schemaVersion: z.literal("agent-endpoint-list/v1"),
    items: z.array(remoteAgentEndpointSchema).max(12_800)
  })
  .strict();

export const agentEndpointErrorCodeSchema = z.enum([
  "agent_endpoint_unauthenticated",
  "agent_endpoint_forbidden",
  "agent_endpoint_request_invalid",
  "agent_endpoint_unknown",
  "agent_endpoint_unavailable",
  "agent_endpoint_incompatible",
  "agent_endpoint_request_failed"
]);

export const agentEndpointErrorResponseSchema = z
  .object({ error: agentEndpointErrorCodeSchema })
  .strict();

const forbiddenEndpointKeys = new Set([
  "hostid",
  "host_id",
  "command",
  "args",
  "env",
  "environment",
  "token",
  "path",
  "readiness",
  "readinessobservation",
  "readiness_json",
  "credential",
  "credentialexpiresat"
]);

/** Assert both the strict wire shape and the absence of Host-local sensitive fields. */
export function assertRemoteAgentEndpointRedacted(
  input: unknown
): asserts input is RemoteAgentEndpoint {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("agent_endpoint_projection_invalid");
  }
  for (const key of Object.keys(input)) {
    if (forbiddenEndpointKeys.has(key.toLowerCase())) {
      throw new Error("agent_endpoint_projection_not_redacted");
    }
  }
  remoteAgentEndpointSchema.parse(input);
}

export type AgentEndpointUnavailableReason = z.infer<typeof agentEndpointUnavailableReasonSchema>;
export type RemoteAgentEndpoint = z.infer<typeof remoteAgentEndpointSchema>;
export type RemoteAgentEndpointList = z.infer<typeof remoteAgentEndpointListSchema>;
export type AgentEndpointErrorCode = z.infer<typeof agentEndpointErrorCodeSchema>;
export type AgentEndpointErrorResponse = z.infer<typeof agentEndpointErrorResponseSchema>;

export { capabilitiesSchema as agentEndpointCapabilitiesSchema };
