import { describe, expect, it } from "vitest";
import {
  agentHostSetupHandoffPrefix,
  agentHostSetupHandoffSchema,
  parseAgentHostSetupHandoff,
  serializeAgentHostSetupHandoff
} from "../index.js";

const handoff = agentHostSetupHandoffSchema.parse({
  version: "agent-host-setup/v2",
  endpoint: {
    topology: "private_https",
    serverOrigin: "https://planweave.tail1234.ts.net",
    allowedClientOrigins: ["https://planweave.tail1234.ts.net"],
    tlsTrust: "system_ca"
  },
  workspaceId: "workspace-1",
  enrollmentCode: `pw_enroll_${"a".repeat(43)}`,
  expiresAt: "2030-01-01T00:00:00.000Z",
  credentialExpiresAt: "2030-06-30T00:00:00.000Z",
  credentialPolicy: { lifetimeDays: 180, renewal: "automatic" },
  display: { workspaceName: "Studio", serverName: "Private server" }
});

describe("Agent Host setup handoff", () => {
  it("round-trips one strict versioned envelope", () => {
    const encoded = serializeAgentHostSetupHandoff(handoff);
    expect(encoded.startsWith(agentHostSetupHandoffPrefix)).toBe(true);
    expect(parseAgentHostSetupHandoff(encoded, new Date("2029-01-01T00:00:00.000Z"))).toEqual(
      handoff
    );
  });

  it("round-trips server-scoped fleet handoffs without workspace binding", () => {
    const fleetHandoff = agentHostSetupHandoffSchema.parse({
      version: "agent-host-setup/v2",
      endpoint: handoff.endpoint,
      enrollmentCode: handoff.enrollmentCode,
      expiresAt: handoff.expiresAt,
      credentialExpiresAt: handoff.credentialExpiresAt,
      credentialPolicy: handoff.credentialPolicy,
      display: { workspaceName: "Owner fleet", serverName: "Private server" }
    });
    const encoded = serializeAgentHostSetupHandoff(fleetHandoff);
    expect(parseAgentHostSetupHandoff(encoded, new Date("2029-01-01T00:00:00.000Z"))).toEqual(
      fleetHandoff
    );
  });

  it("rejects expiration, unknown fields, and invalid endpoint policy", () => {
    expect(() =>
      parseAgentHostSetupHandoff(serializeAgentHostSetupHandoff(handoff), new Date("2031-01-01"))
    ).toThrow("agent_host_setup_handoff_expired");
    expect(() =>
      agentHostSetupHandoffSchema.parse({ ...handoff, hostId: "must-not-cross" })
    ).toThrow();
    expect(() =>
      agentHostSetupHandoffSchema.parse({
        ...handoff,
        endpoint: { ...handoff.endpoint, topology: "lan_http", tlsTrust: "not_applicable" }
      })
    ).toThrow();
  });

  it("contains no Host credential or machine-local execution fields", () => {
    const serialized = JSON.stringify(handoff);
    for (const forbidden of [
      "hostId",
      "credentialToken",
      "operatorId",
      "workspaceRoot",
      "command",
      "environment",
      "caCertificatePath",
      "acpToken"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
