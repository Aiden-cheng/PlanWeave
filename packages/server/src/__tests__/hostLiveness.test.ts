import { describe, expect, it } from "vitest";
import { isAgentHostOnline, operatorHostAvailability, type AgentHost } from "../hosts.js";

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
    expect(isAgentHostOnline(host({ revokedAt: "2030-01-01T00:00:45.000Z" }), { now })).toBe(false);
    expect(
      isAgentHostOnline(host({ credentialExpiresAt: "2030-01-01T00:00:59.000Z" }), { now })
    ).toBe(false);
  });

  it("composes typed availability from liveness and redacted readiness observations", () => {
    expect(operatorHostAvailability(host(), "workspace-a", true)).toEqual({
      status: "unavailable",
      reason: "readiness_not_reported"
    });
    expect(
      operatorHostAvailability(
        host({
          readinessObservation: {
            workspaceMappings: [{ workspaceId: "workspace-a", status: "ready" }],
            acpProfiles: []
          }
        }),
        "workspace-a",
        true
      )
    ).toEqual({ status: "unavailable", reason: "acp_profile_missing" });
    expect(
      operatorHostAvailability(
        host({
          capabilities: ["acp.codex"],
          readinessObservation: {
            workspaceMappings: [{ workspaceId: "workspace-a", status: "ready" }],
            acpProfiles: [
              {
                profileId: "codex-acp",
                agentId: "codex",
                status: "ready",
                capabilities: ["acp.codex"]
              }
            ]
          }
        }),
        "workspace-a",
        true
      )
    ).toEqual({ status: "available", reason: null });
    expect(
      operatorHostAvailability(host({ revokedAt: now.toISOString() }), "workspace-a", false)
    ).toEqual({
      status: "unavailable",
      reason: "revoked"
    });
  });
});
