import { describe, expect, it } from "vitest";
import { isAgentHostOnline, type AgentHost } from "../hosts.js";

const now = new Date("2030-01-01T00:01:00.000Z");

function host(overrides: Partial<AgentHost> = {}): AgentHost {
  return {
    id: "host-1",
    displayName: "Host 1",
    capabilities: [],
    capacity: 1,
    lastAcknowledgedSequence: 0,
    lastSeenAt: "2030-01-01T00:00:30.000Z",
    credentialExpiresAt: "2030-01-01T01:00:00.000Z",
    ...overrides
  };
}

describe("server-authoritative Host liveness", () => {
  it("uses the configured heartbeat window", () => {
    expect(isAgentHostOnline(host(), { now, hostOfflineAfterMs: 60_000 })).toBe(true);
    expect(isAgentHostOnline(host(), { now, hostOfflineAfterMs: 20_000 })).toBe(false);
  });

  it("keeps missing, revoked, and credential-expired Hosts offline", () => {
    expect(isAgentHostOnline(host({ lastSeenAt: undefined }), { now })).toBe(false);
    expect(
      isAgentHostOnline(host({ revokedAt: "2030-01-01T00:00:45.000Z" }), { now })
    ).toBe(false);
    expect(
      isAgentHostOnline(host({ credentialExpiresAt: "2030-01-01T00:00:59.000Z" }), { now })
    ).toBe(false);
  });
});
