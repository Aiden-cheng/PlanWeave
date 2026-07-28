import { describe, expect, it } from "vitest";
import {
  agentHostAvailabilityViewSchema,
  assertDeploymentViewRedacted,
  connectivityValidationViewSchema,
  deploymentConnectionProfileSchema,
  deploymentGuidanceViewSchema,
  deploymentWebSocketOrigin,
  desktopDeploymentActionRequestSchema
} from "../index.js";

const capabilities = [
  "workspace_connection",
  "deployment_guidance",
  "connectivity_validation",
  "agent_host_availability"
] as const;

const selfHostedProfile = {
  schemaVersion: "deployment-connection/v1",
  profileId: "profile-self-hosted-001",
  displayName: "Self-hosted Workspace",
  workspace: { workspaceId: "workspace-001" },
  endpoint: {
    topology: "public_https",
    serverOrigin: "https://collab.example.test/",
    allowedClientOrigins: ["https://desktop.example.test/"],
    tlsTrust: "system_ca"
  },
  capabilities
};

describe("OSS-009 deployment and Host availability contracts", () => {
  it("distinguishes loopback HTTP from LAN and public trusted HTTPS/WSS", () => {
    const loopback = deploymentConnectionProfileSchema.parse({
      ...selfHostedProfile,
      profileId: "profile-loopback-001",
      endpoint: {
        topology: "loopback_http",
        serverOrigin: "http://127.0.0.1:8787/",
        allowedClientOrigins: ["http://localhost:5173/"],
        tlsTrust: "not_applicable"
      }
    });
    expect(deploymentWebSocketOrigin(loopback.endpoint)).toBe("ws://127.0.0.1:8787/");

    const lan = deploymentConnectionProfileSchema.parse({
      ...selfHostedProfile,
      profileId: "profile-lan-001",
      endpoint: {
        topology: "lan_https",
        serverOrigin: "https://collab.lan:8443/",
        allowedClientOrigins: ["https://desktop.lan/"],
        tlsTrust: "configured_ca"
      }
    });
    expect(deploymentWebSocketOrigin(lan.endpoint)).toBe("wss://collab.lan:8443/");

    expect(() =>
      deploymentConnectionProfileSchema.parse({
        ...selfHostedProfile,
        endpoint: {
          topology: "loopback_http",
          serverOrigin: "http://collab.example.test/",
          allowedClientOrigins: ["http://localhost:5173/"],
          tlsTrust: "not_applicable"
        }
      })
    ).toThrow("loopback_http_requires_loopback_http_origins_without_tls");
    expect(() =>
      deploymentConnectionProfileSchema.parse({
        ...selfHostedProfile,
        endpoint: {
          topology: "lan_https",
          serverOrigin: "http://collab.lan/",
          allowedClientOrigins: ["https://desktop.lan/"],
          tlsTrust: "system_ca"
        }
      })
    ).toThrow("network_topology_requires_trusted_non_loopback_https_origins");
    expect(() =>
      deploymentConnectionProfileSchema.parse({
        ...selfHostedProfile,
        endpoint: {
          ...selfHostedProfile.endpoint,
          allowedClientOrigins: ["https://desktop.example.test/", "https://desktop.example.test/"]
        }
      })
    ).toThrow("duplicate_allowed_client_origin");
    expect(() =>
      deploymentConnectionProfileSchema.parse({
        ...selfHostedProfile,
        endpoint: {
          ...selfHostedProfile.endpoint,
          serverOrigin: "https://collab.example.test:8443/"
        }
      })
    ).toThrow("public_https_requires_direct_tls_port_443");
    expect(() =>
      deploymentConnectionProfileSchema.parse({
        ...selfHostedProfile,
        endpoint: {
          ...selfHostedProfile.endpoint,
          allowedClientOrigins: ["http://desktop.example.test/"],
          tlsTrust: "not_applicable"
        }
      })
    ).toThrow("network_topology_requires_trusted_non_loopback_https_origins");
  });

  it("uses the same opaque Workspace scope and capability model for hosted origins", () => {
    const selfHosted = deploymentConnectionProfileSchema.parse(selfHostedProfile);
    const hosted = deploymentConnectionProfileSchema.parse({
      ...selfHostedProfile,
      profileId: "profile-hosted-001",
      displayName: "Hosted Workspace",
      endpoint: {
        topology: "public_https",
        serverOrigin: "https://workspace.example.test/",
        allowedClientOrigins: ["https://desktop.example.test/"],
        tlsTrust: "system_ca"
      }
    });
    expect(hosted.workspace).toEqual(selfHosted.workspace);
    expect(hosted.capabilities).toEqual(selfHosted.capabilities);
    expect(() =>
      deploymentConnectionProfileSchema.parse({
        ...selfHostedProfile,
        provider: "example-cloud"
      })
    ).toThrow();
  });

  it("requires durable state, healthchecks, and direct TLS on public guidance", () => {
    const guidance = deploymentGuidanceViewSchema.parse({
      schemaVersion: "deployment-connection/v1",
      workspace: { workspaceId: "workspace-001" },
      profileId: selfHostedProfile.profileId,
      state: "ready",
      requirements: {
        durableState: "required",
        healthcheck: { required: true },
        publicIngress: { tls: "direct", port: 443 }
      },
      generatedAt: "2030-01-01T00:00:00.000Z",
      unavailableReason: null
    });
    expect(guidance.requirements.publicIngress?.port).toBe(443);
    expect(() =>
      deploymentGuidanceViewSchema.parse({
        ...guidance,
        requirements: {
          ...guidance.requirements,
          publicIngress: { tls: "direct", port: 8443 }
        }
      })
    ).toThrow();
  });

  it("limits renderer requests to reviewable guidance, validation, and Host availability", () => {
    const request = desktopDeploymentActionRequestSchema.parse({
      action: "validate_connectivity",
      workspace: { workspaceId: "workspace-001" },
      profile: selfHostedProfile
    });
    expect(request.action).toBe("validate_connectivity");
    expect(() =>
      desktopDeploymentActionRequestSchema.parse({
        ...request,
        action: "ssh",
        command: "ssh root@example.test"
      })
    ).toThrow();
    expect(() =>
      desktopDeploymentActionRequestSchema.parse({
        ...request,
        action: "provision_vps"
      })
    ).toThrow();
  });

  it("keeps connectivity and native Agent Host availability views redacted", () => {
    const connectivity = connectivityValidationViewSchema.parse({
      schemaVersion: "deployment-connection/v1",
      workspace: { workspaceId: "workspace-001" },
      profileId: selfHostedProfile.profileId,
      endpoint: selfHostedProfile.endpoint,
      status: "reachable",
      checkedAt: "2030-01-01T00:00:00.000Z",
      failureCode: null
    });
    const host = agentHostAvailabilityViewSchema.parse({
      schemaVersion: "deployment-connection/v1",
      workspace: { workspaceId: "workspace-001" },
      hostId: "host-001",
      status: "available",
      capabilities: ["acp.codex", "workspace.git"],
      workspaceMapping: { status: "ready" },
      acpProfiles: [{ profileId: "acp-profile-001", status: "ready", capabilities: ["acp.codex"] }],
      observedAt: "2030-01-01T00:00:00.000Z",
      reason: null
    });
    assertDeploymentViewRedacted(connectivity);
    assertDeploymentViewRedacted(host);
    expect(() => assertDeploymentViewRedacted({ secret: "pw_host_ABCDEFGHIJK" })).toThrow(
      "deployment_view_not_redacted"
    );
    expect(() =>
      agentHostAvailabilityViewSchema.parse({ ...host, status: "unavailable", reason: null })
    ).toThrow("agent_host_availability_reason_mismatch");
    expect(() =>
      agentHostAvailabilityViewSchema.parse({
        ...host,
        workspaceMapping: { status: "missing" }
      })
    ).toThrow("available_agent_host_requires_workspace_and_acp");
    expect(() =>
      agentHostAvailabilityViewSchema.parse({
        ...host,
        acpProfiles: [{ profileId: "acp-profile-001", status: "invalid", capabilities: [] }]
      })
    ).toThrow("available_agent_host_requires_workspace_and_acp");
  });
});
