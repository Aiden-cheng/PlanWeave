import { describe, expect, it } from "vitest";
import {
  AgentEndpointCatalog,
  AgentEndpointCatalogError,
  type AgentEndpointCapacityPort,
  type AgentEndpointHostPort
} from "../agentEndpointCatalog.js";
import type { AgentHost } from "../hosts.js";

const now = new Date("2026-08-03T08:00:00.000Z");

function readyHost(overrides: Partial<AgentHost> = {}): AgentHost {
  return {
    id: "host-primary",
    displayName: "Build Mac",
    capabilities: ["acp.codex", "host-only"],
    capacity: 2,
    lastSeenAt: now.toISOString(),
    lastAcknowledgedSequence: 0,
    credentialExpiresAt: "2026-08-04T08:00:00.000Z",
    readinessObservation: {
      workspaceMappings: [{ workspaceId: "workspace-a", status: "ready" }],
      acpProfiles: [
        {
          profileId: "profile-main",
          agentId: "codex",
          displayName: "Codex",
          status: "ready",
          capabilities: ["acp.codex"]
        }
      ]
    },
    ...overrides
  };
}

function fixture(hostsInput: AgentHost[] = [readyHost()]) {
  let hosts = hostsInput;
  let counts = new Map<string, number>();
  const hostPort: AgentEndpointHostPort = {
    listExclusivelyBoundToWorkspace: () => hosts
  };
  const capacityPort: AgentEndpointCapacityPort = {
    activeCountsForHosts: (hostIds) =>
      new Map(hostIds.map((hostId) => [hostId, counts.get(hostId) ?? 0]))
  };
  const catalog = new AgentEndpointCatalog({
    hosts: hostPort,
    capacities: capacityPort,
    hostOfflineAfterMs: 60_000,
    clock: () => now
  });
  return {
    catalog,
    setHosts(next: AgentHost[]) {
      hosts = next;
    },
    setActive(hostId: string, count: number) {
      counts = new Map(counts).set(hostId, count);
    }
  };
}

function endpointFor(host: AgentHost = readyHost(), workspaceId = "workspace-a") {
  return fixture([host]).catalog.listVisible(workspaceId).items[0];
}

describe("AgentEndpointCatalog", () => {
  it("keeps IDs stable across presentation and availability changes", () => {
    const original = endpointFor();
    const changed = endpointFor(
      readyHost({
        displayName: "Renamed Host",
        capacity: 8,
        lastSeenAt: "2026-08-03T07:00:00.000Z",
        readinessObservation: {
          workspaceMappings: [{ workspaceId: "workspace-a", status: "ready" }],
          acpProfiles: [
            {
              profileId: "profile-main",
              agentId: "codex",
              displayName: "Renamed Agent",
              status: "ready",
              capabilities: ["acp.codex"]
            }
          ]
        }
      })
    );
    expect(changed?.endpointId).toBe(original?.endpointId);
    expect(changed).toMatchObject({ status: "unavailable", unavailableReason: "host_offline" });
  });

  it("isolates IDs by workspace, Host, profile, and agent identity", () => {
    const base = endpointFor()?.endpointId;
    const variants = [
      endpointFor(readyHost({ id: "host-other" }))?.endpointId,
      endpointFor(
        readyHost({
          readinessObservation: {
            workspaceMappings: [{ workspaceId: "workspace-a", status: "ready" }],
            acpProfiles: [
              {
                profileId: "profile-other",
                agentId: "codex",
                displayName: "Codex",
                status: "ready",
                capabilities: ["acp.codex"]
              }
            ]
          }
        })
      )?.endpointId,
      endpointFor(
        readyHost({
          readinessObservation: {
            workspaceMappings: [{ workspaceId: "workspace-a", status: "ready" }],
            acpProfiles: [
              {
                profileId: "profile-main",
                agentId: "other-agent",
                displayName: "Other",
                status: "ready",
                capabilities: ["acp.codex"]
              }
            ]
          }
        })
      )?.endpointId,
      endpointFor(
        readyHost({
          readinessObservation: {
            workspaceMappings: [{ workspaceId: "workspace-b", status: "ready" }],
            acpProfiles: readyHost().readinessObservation!.acpProfiles
          }
        }),
        "workspace-b"
      )?.endpointId
    ];
    expect(new Set([base, ...variants]).size).toBe(5);
  });

  it.each([
    ["offline", { lastSeenAt: "2026-08-03T07:00:00.000Z" }, "host_offline"],
    ["revoked", { revokedAt: "2026-08-03T07:59:00.000Z" }, "host_revoked"],
    ["expired", { credentialExpiresAt: now.toISOString() }, "host_credential_expired"]
  ] as const)("projects %s Host state", (_name, overrides, reason) => {
    expect(endpointFor(readyHost(overrides))).toMatchObject({
      status: "unavailable",
      unavailableReason: reason
    });
  });

  it.each([
    ["missing", "workspace_mapping_missing"],
    ["invalid", "workspace_mapping_invalid"]
  ] as const)("projects a %s workspace mapping", (status, reason) => {
    const host = readyHost();
    host.readinessObservation = {
      workspaceMappings: [{ workspaceId: "workspace-a", status }],
      acpProfiles: host.readinessObservation!.acpProfiles
    };
    expect(endpointFor(host)).toMatchObject({ status: "unavailable", unavailableReason: reason });
  });

  it("treats a profile capability outside the Host capability set as invalid", () => {
    const host = readyHost();
    host.readinessObservation!.acpProfiles[0]!.capabilities = ["profile-only"];
    expect(endpointFor(host)).toMatchObject({
      status: "unavailable",
      unavailableReason: "profile_invalid"
    });
  });

  it.each([
    ["missing", "profile_missing"],
    ["invalid", "profile_invalid"]
  ] as const)("projects a %s exact profile", (status, reason) => {
    const host = readyHost();
    host.readinessObservation!.acpProfiles[0]!.status = status;
    expect(endpointFor(host)).toMatchObject({ status: "unavailable", unavailableReason: reason });
  });

  it("uses active reservations for capacity without changing endpoint identity", () => {
    const state = fixture();
    const before = state.catalog.listVisible("workspace-a").items[0]!;
    state.setActive("host-primary", 2);
    const after = state.catalog.listVisible("workspace-a").items[0]!;
    expect(after.endpointId).toBe(before.endpointId);
    expect(after).toMatchObject({ status: "unavailable", unavailableReason: "at_capacity" });
  });

  it("resolves from a fresh snapshot and checks Host and profile capabilities separately", () => {
    const state = fixture();
    const endpoint = state.catalog.listVisible("workspace-a").items[0]!;
    expect(
      state.catalog.resolveForRun(endpoint.endpointId, "workspace-a", ["acp.codex"])
    ).toMatchObject({ hostId: "host-primary", profileId: "profile-main", agentId: "codex" });
    expect(() =>
      state.catalog.resolveForRun(endpoint.endpointId, "workspace-a", ["host-only"])
    ).toThrowError(new AgentEndpointCatalogError("agent_endpoint_incompatible"));
  });

  it("fails a stale endpoint instead of rerouting to another compatible Host", () => {
    const first = readyHost();
    const second = readyHost({ id: "host-secondary", displayName: "Second Host" });
    const state = fixture([first, second]);
    const endpoint = state.catalog
      .listVisible("workspace-a")
      .items.find((item) => item.hostDisplayName === "Build Mac")!;
    state.setHosts([{ ...first, lastSeenAt: "2026-08-03T07:00:00.000Z" }, second]);
    expect(() =>
      state.catalog.resolveForRun(endpoint.endpointId, "workspace-a", ["acp.codex"])
    ).toThrowError(new AgentEndpointCatalogError("agent_endpoint_unavailable"));
  });

  it("returns one stable unknown error when the endpoint identity disappears", () => {
    const state = fixture();
    const endpoint = state.catalog.listVisible("workspace-a").items[0]!;
    state.setHosts([]);
    expect(() => state.catalog.resolveForRun(endpoint.endpointId, "workspace-a", [])).toThrowError(
      new AgentEndpointCatalogError("agent_endpoint_unknown")
    );
  });

  it("returns opaque, strictly redacted projections", () => {
    const serialized = JSON.stringify(fixture().catalog.listVisible("workspace-a"));
    expect(serialized).not.toContain("host-primary");
    for (const sensitive of [
      '"hostId"',
      '"command"',
      '"args"',
      '"env"',
      '"token"',
      '"path"',
      '"readinessObservation"'
    ]) {
      expect(serialized).not.toContain(sensitive);
    }
  });
});
