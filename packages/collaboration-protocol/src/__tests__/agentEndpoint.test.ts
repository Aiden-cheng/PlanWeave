import { describe, expect, it } from "vitest";
import {
  assertRemoteAgentEndpointRedacted,
  remoteAgentEndpointListSchema,
  remoteAgentEndpointSchema
} from "../agentEndpoint.js";

const endpoint = {
  schemaVersion: "agent-endpoint/v1",
  endpointId: "aep_0123456789abcdef",
  agentId: "codex",
  profileId: "default",
  displayName: "Codex",
  hostDisplayName: "Build Mac",
  status: "available",
  capabilities: ["acp.codex"]
} as const;

describe("agent endpoint protocol", () => {
  it("strictly parses a redacted endpoint and list response", () => {
    expect(remoteAgentEndpointSchema.parse(endpoint)).toEqual(endpoint);
    expect(
      remoteAgentEndpointListSchema.parse({
        schemaVersion: "agent-endpoint-list/v1",
        items: [endpoint]
      })
    ).toEqual({ schemaVersion: "agent-endpoint-list/v1", items: [endpoint] });
    expect(() => remoteAgentEndpointSchema.parse({ ...endpoint, hostId: "host-secret" })).toThrow();
  });

  it("requires a bounded reason only for unavailable endpoints", () => {
    expect(() => remoteAgentEndpointSchema.parse({ ...endpoint, status: "unavailable" })).toThrow();
    expect(() =>
      remoteAgentEndpointSchema.parse({
        ...endpoint,
        unavailableReason: "host_offline"
      })
    ).toThrow();
    expect(
      remoteAgentEndpointSchema.parse({
        ...endpoint,
        status: "unavailable",
        unavailableReason: "at_capacity"
      })
    ).toMatchObject({ status: "unavailable", unavailableReason: "at_capacity" });
  });

  it("has a dedicated redaction assertion for sensitive Host fields", () => {
    expect(() => assertRemoteAgentEndpointRedacted(endpoint)).not.toThrow();
    for (const sensitive of [
      "hostId",
      "command",
      "args",
      "env",
      "token",
      "path",
      "readinessObservation"
    ]) {
      expect(() =>
        assertRemoteAgentEndpointRedacted({ ...endpoint, [sensitive]: "secret" })
      ).toThrow("agent_endpoint_projection_not_redacted");
    }
  });
});
