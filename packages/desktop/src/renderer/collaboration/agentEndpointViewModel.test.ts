import { describe, expect, it } from "vitest";
import {
  applyAgentEndpointRequirements,
  agentEndpointDisplayLabel,
  buildAgentEndpointCatalog,
  buildAvailableAgentEndpoints,
  buildLocalAgentEndpoint
} from "./agentEndpointViewModel";

describe("buildAgentEndpointCatalog", () => {
  it("keeps built-in, custom, and multiple same-family remote Endpoints together", () => {
    const endpoints = buildAgentEndpointCatalog({
      logicalExecutors: [
        {
          executorName: "codex",
          profileId: "codex",
          agentId: "codex",
          displayName: "Codex",
          capabilities: ["acp.codex"],
          available: true,
          unavailableReason: null,
          custom: false
        },
        {
          executorName: "custom-shell",
          profileId: "custom-shell",
          agentId: null,
          displayName: "custom-shell",
          capabilities: [],
          available: true,
          unavailableReason: null,
          custom: true
        }
      ],
      remote: [
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-windows",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "LINANIML",
          status: "available",
          capabilities: ["acp.codex"]
        },
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-vps",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "VPS",
          status: "available",
          capabilities: ["acp.codex"]
        }
      ]
    });

    expect(endpoints.map((endpoint) => endpoint.id)).toEqual([
      "local:codex",
      "local:custom-shell",
      "remote:endpoint-windows",
      "remote:endpoint-vps"
    ]);
    expect(endpoints.map(agentEndpointDisplayLabel)).toEqual([
      "Codex",
      "custom-shell",
      "Codex · LINANIML",
      "Codex · VPS"
    ]);
    expect(endpoints.map((endpoint) => endpoint.executorName)).toEqual([
      "codex",
      "custom-shell",
      "codex",
      "codex"
    ]);
  });

  it("keeps incompatible Endpoints visible but disabled", () => {
    const endpoints = applyAgentEndpointRequirements(
      buildAgentEndpointCatalog({
        logicalExecutors: [
          {
            executorName: "codex",
            profileId: "codex",
            agentId: "codex",
            displayName: "Codex",
            capabilities: [],
            available: true,
            unavailableReason: null,
            custom: false
          }
        ],
        remote: []
      }),
      ["acp.codex"]
    );

    expect(endpoints[0]).toMatchObject({
      id: "local:codex",
      available: false,
      unavailableReason: "agent_endpoint_incompatible"
    });
  });

  it("does not let a same-named custom logic executor claim a remote Agent profile", () => {
    const endpoints = buildAgentEndpointCatalog({
      logicalExecutors: [
        {
          executorName: "codex-acp",
          profileId: "codex-acp",
          agentId: null,
          displayName: "codex-acp",
          capabilities: [],
          available: true,
          unavailableReason: null,
          custom: true
        }
      ],
      remote: [
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-windows",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "LINANIML",
          status: "available",
          capabilities: ["acp.codex"]
        }
      ]
    });

    expect(endpoints[1]).toMatchObject({
      id: "remote:endpoint-windows",
      available: false,
      unavailableReason: "agent_endpoint_incompatible"
    });
  });
});

describe("buildLocalAgentEndpoint", () => {
  it.each([
    ["not run", false, null, null, true],
    ["loading", true, null, null, false],
    ["failure result", false, null, false, false],
    ["preflight error", false, "preflight failed", null, false],
    ["explicit success", false, null, true, true]
  ] as const)("keeps preflight optional but respects an observed %s state", (_name, preflightLoading, preflightError, preflightOk, available) => {
    expect(
      buildLocalAgentEndpoint({
        executorName: "codex-acp",
        displayName: "Codex",
        locationName: "This device",
        capabilities: ["acp.codex"],
        profileExists: true,
        detected: true,
        preflightLoading,
        preflightError,
        preflightOk
      })
    ).toMatchObject({
      available,
      unavailableReason: available ? null : "agent_endpoint_local_preflight_failed"
    });
  });
});

describe("buildAvailableAgentEndpoints", () => {
  it("keeps local and remote instances distinct while suffixing only the remote Host", () => {
    const endpoints = buildAvailableAgentEndpoints({
      local: [
        {
          executorName: "codex",
          displayName: "Codex",
          locationName: "This device",
          capabilities: ["acp.codex"],
          available: true,
          unavailableReason: null
        }
      ],
      requiredProfileId: "codex",
      requiredAgentId: "codex",
      requiredCapabilities: ["acp.codex"],
      remote: [
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-windows",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "LINANIML",
          status: "available",
          capabilities: ["acp.codex"]
        }
      ]
    });

    expect(endpoints.map((endpoint) => endpoint.id)).toEqual([
      "local:codex",
      "remote:endpoint-windows"
    ]);
    expect(endpoints.map(agentEndpointDisplayLabel)).toEqual(["Codex", "Codex · LINANIML"]);
    expect(endpoints.every((endpoint) => endpoint.available)).toBe(true);
  });

  it("does not let an Agent-family match override a custom profile identity", () => {
    const endpoints = buildAvailableAgentEndpoints({
      local: [],
      requiredProfileId: "custom-codex-review",
      requiredAgentId: null,
      requiredCapabilities: ["acp.codex"],
      remote: [
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-windows",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "LINANIML",
          status: "available",
          capabilities: ["acp.codex"]
        }
      ]
    });

    expect(endpoints[0]).toMatchObject({
      id: "remote:endpoint-windows",
      available: false,
      unavailableReason: "agent_endpoint_incompatible"
    });
  });

  it("merges all local candidates with compatible remote Endpoints", () => {
    const endpoints = buildAvailableAgentEndpoints({
      local: [
        {
          executorName: "codex-acp",
          displayName: "Codex",
          locationName: "This device",
          capabilities: ["acp.codex"],
          available: true,
          unavailableReason: null
        },
        {
          executorName: "claude-acp",
          displayName: "Claude",
          locationName: "This device",
          capabilities: ["acp.claude-code"],
          available: true,
          unavailableReason: null
        }
      ],
      requiredProfileId: "codex-acp",
      requiredCapabilities: ["acp.codex"],
      remote: [
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-vps",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "VPS",
          status: "available",
          capabilities: ["acp.codex"]
        },
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-other",
          profileId: "other-profile",
          agentId: "codex",
          displayName: "Other",
          hostDisplayName: "Build Mac",
          status: "available",
          capabilities: ["acp.codex"]
        }
      ]
    });

    expect(endpoints).toEqual([
      expect.objectContaining({ id: "local:codex-acp", source: "local", available: true }),
      expect.objectContaining({
        id: "local:claude-acp",
        source: "local",
        available: false,
        unavailableReason: "agent_endpoint_incompatible"
      }),
      expect.objectContaining({
        id: "remote:endpoint-vps",
        source: "remote",
        locationName: "VPS",
        available: true,
        remoteEndpointId: "endpoint-vps"
      }),
      expect.objectContaining({
        id: "remote:endpoint-other",
        available: false,
        unavailableReason: "agent_endpoint_incompatible"
      })
    ]);
  });

  it("keeps Server availability failures visible and disabled", () => {
    const endpoints = buildAvailableAgentEndpoints({
      local: [],
      requiredProfileId: "codex-acp",
      requiredCapabilities: ["acp.codex"],
      remote: [
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-offline",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "VPS",
          status: "unavailable",
          unavailableReason: "host_offline",
          capabilities: ["acp.codex"]
        }
      ]
    });
    expect(endpoints[0]).toMatchObject({
      available: false,
      unavailableReason: "host_offline"
    });
  });

  it("omits permanently dead Hosts from the executor picker", () => {
    const endpoints = buildAvailableAgentEndpoints({
      local: [],
      requiredProfileId: "codex-acp",
      requiredCapabilities: ["acp.codex"],
      remote: [
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-revoked",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "LINANIML",
          status: "unavailable",
          unavailableReason: "host_revoked",
          capabilities: ["acp.codex"]
        },
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-expired",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "LINANIML",
          status: "unavailable",
          unavailableReason: "host_credential_expired",
          capabilities: ["acp.codex"]
        },
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-offline",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "LINANIML",
          status: "unavailable",
          unavailableReason: "host_offline",
          capabilities: ["acp.codex"]
        }
      ]
    });
    expect(endpoints.map((endpoint) => endpoint.id)).toEqual(["remote:endpoint-offline"]);
  });

  it("keeps capability-incompatible Endpoints visible and disabled", () => {
    const endpoints = buildAvailableAgentEndpoints({
      local: [],
      requiredProfileId: "codex-acp",
      requiredCapabilities: ["acp.codex", "network"],
      remote: [
        {
          schemaVersion: "agent-endpoint/v1",
          endpointId: "endpoint-without-network",
          profileId: "codex-acp",
          agentId: "codex",
          displayName: "Codex",
          hostDisplayName: "VPS",
          status: "available",
          capabilities: ["acp.codex"]
        }
      ]
    });

    expect(endpoints[0]).toMatchObject({
      id: "remote:endpoint-without-network",
      available: false,
      unavailableReason: "agent_endpoint_incompatible"
    });
  });

  it("applies required capabilities to local Endpoints too", () => {
    const endpoints = buildAvailableAgentEndpoints({
      local: [
        {
          executorName: "codex-acp",
          displayName: "Codex",
          locationName: "This device",
          capabilities: ["acp.codex"],
          available: true,
          unavailableReason: null
        }
      ],
      requiredProfileId: "codex-acp",
      requiredCapabilities: ["acp.codex", "linux"],
      remote: []
    });

    expect(endpoints[0]).toMatchObject({
      id: "local:codex-acp",
      available: false,
      unavailableReason: "agent_endpoint_incompatible"
    });
  });
});
