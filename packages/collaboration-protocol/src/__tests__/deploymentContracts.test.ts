import { describe, expect, it } from "vitest";
import {
  agentHostAvailabilityViewSchema,
  assertDeploymentViewRedacted,
  connectivityValidationViewSchema,
  deploymentConnectionProfileSchema,
  deploymentGuidanceViewSchema,
  deploymentTargetDraftSchema,
  deploymentWebSocketOrigin,
  desktopDeploymentActionRequestSchema
} from "../deployment.js";

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

const deploymentTarget = {
  schemaVersion: "deployment-target-draft/v1",
  displayName: "Self-hosted Server",
  endpoint: selfHostedProfile.endpoint,
  capabilities: ["deployment_guidance", "connectivity_validation"]
};

describe("OSS-009 deployment and Host availability contracts", () => {
  it("distinguishes loopback HTTP and HTTPS from LAN and public trusted HTTPS/WSS", () => {
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

    const insecureLan = deploymentConnectionProfileSchema.parse({
      ...selfHostedProfile,
      profileId: "profile-insecure-lan-001",
      endpoint: {
        topology: "lan_http",
        serverOrigin: "http://192.168.1.20:8787/",
        allowedClientOrigins: ["http://192.168.1.20:8787/"],
        tlsTrust: "not_applicable"
      }
    });
    expect(deploymentWebSocketOrigin(insecureLan.endpoint)).toBe("ws://192.168.1.20:8787/");

    const secureLoopback = deploymentConnectionProfileSchema.parse({
      ...selfHostedProfile,
      profileId: "profile-secure-loopback-001",
      endpoint: {
        topology: "loopback_https",
        serverOrigin: "https://127.0.0.1:7443/",
        allowedClientOrigins: ["https://localhost:7443/"],
        tlsTrust: "configured_ca"
      }
    });
    expect(deploymentWebSocketOrigin(secureLoopback.endpoint)).toBe("wss://127.0.0.1:7443/");

    const privateNetwork = deploymentConnectionProfileSchema.parse({
      ...selfHostedProfile,
      profileId: "profile-lan-001",
      endpoint: {
        topology: "private_https",
        serverOrigin: "https://collab.lan:8443/",
        allowedClientOrigins: ["https://desktop.lan/"],
        tlsTrust: "configured_ca"
      }
    });
    expect(deploymentWebSocketOrigin(privateNetwork.endpoint)).toBe("wss://collab.lan:8443/");

    const systemTrustedPrivateNetwork = deploymentConnectionProfileSchema.parse({
      ...selfHostedProfile,
      profileId: "profile-private-system-ca-001",
      endpoint: {
        topology: "private_https",
        serverOrigin: "https://planweave.tailnet.ts.net/",
        allowedClientOrigins: ["https://planweave.tailnet.ts.net/"],
        tlsTrust: "system_ca"
      }
    });
    expect(deploymentWebSocketOrigin(systemTrustedPrivateNetwork.endpoint)).toBe(
      "wss://planweave.tailnet.ts.net/"
    );

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
          topology: "lan_http",
          serverOrigin: "http://example.com/",
          allowedClientOrigins: ["http://example.com/"],
          tlsTrust: "not_applicable"
        }
      })
    ).toThrow("lan_http_requires_private_http_origins_without_tls");
    expect(() =>
      deploymentConnectionProfileSchema.parse({
        ...selfHostedProfile,
        endpoint: {
          topology: "loopback_https",
          serverOrigin: "https://collab.example.test/",
          allowedClientOrigins: ["https://127.0.0.1:7443/"],
          tlsTrust: "configured_ca"
        }
      })
    ).toThrow("loopback_https_requires_trusted_loopback_https_origins");
    expect(() =>
      deploymentConnectionProfileSchema.parse({
        ...selfHostedProfile,
        endpoint: {
          topology: "loopback_https",
          serverOrigin: "https://127.0.0.1:7443/",
          allowedClientOrigins: ["https://127.0.0.1:7443/"],
          tlsTrust: "not_applicable"
        }
      })
    ).toThrow("loopback_https_requires_trusted_loopback_https_origins");
    expect(() =>
      deploymentConnectionProfileSchema.parse({
        ...selfHostedProfile,
        endpoint: {
          topology: "private_https",
          serverOrigin: "http://collab.lan/",
          allowedClientOrigins: ["https://desktop.lan/"],
          tlsTrust: "system_ca"
        }
      })
    ).toThrow("network_topology_requires_trusted_non_loopback_https_origins");
    for (const endpoint of [
      {
        topology: "private_https",
        serverOrigin: "https://planweave.example.test/",
        allowedClientOrigins: ["https://planweave.example.test/"],
        tlsTrust: "system_ca"
      },
      {
        topology: "private_https",
        serverOrigin: "https://planweave.tailnet.ts.net:8443/",
        allowedClientOrigins: ["https://planweave.tailnet.ts.net:8443/"],
        tlsTrust: "system_ca"
      },
      {
        topology: "private_https",
        serverOrigin: "https://planweave.tailnet.ts.net/",
        allowedClientOrigins: ["https://planweave.tailnet.ts.net/"],
        tlsTrust: "configured_ca"
      }
    ]) {
      expect(
        deploymentConnectionProfileSchema.parse({ ...selfHostedProfile, endpoint })
      ).toMatchObject({ endpoint });
    }
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
      schemaVersion: "deployment-target-draft/v1",
      target: deploymentTarget,
      state: "ready",
      requirements: {
        durableState: "required",
        healthcheck: { required: true },
        publicIngress: { tls: "direct", port: 443 }
      },
      handoff: {
        state: "supported",
        copyAction: "copy_supported_compose_handoff",
        preview:
          "test -f tls/server.crt && test -f tls/server.key && docker compose -f compose.yaml up --build --detach --wait",
        exportAction: "export_supported_compose_bundle",
        configInputPath: "./server.json",
        tlsDirectory: "./tls",
        projectsRoot: "./projects",
        projectsMountTarget: "/var/lib/planweave/projects",
        trustedProjectRootPattern: "/var/lib/planweave/projects/<project-id>"
      },
      generatedAt: "2030-01-01T00:00:00.000Z",
      unavailableReason: null
    });
    expect(guidance.requirements.publicIngress?.port).toBe(443);
    expect(guidance.handoff.projectsMountTarget).toBe("/var/lib/planweave/projects");
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
      target: deploymentTarget
    });
    expect(request.action).toBe("validate_connectivity");
    expect(deploymentTargetDraftSchema.parse(request.target)).toEqual(deploymentTarget);
    expect(() =>
      desktopDeploymentActionRequestSchema.parse({
        action: "validate_connectivity",
        target: deploymentTarget,
        workspace: { workspaceId: "workspace-001" }
      })
    ).toThrow();
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
      schemaVersion: "deployment-target-draft/v1",
      target: deploymentTarget,
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

  it("requires an explicit failure code for every non-reachable connectivity state", () => {
    expect(() =>
      connectivityValidationViewSchema.parse({
        schemaVersion: "deployment-target-draft/v1",
        target: deploymentTarget,
        endpoint: selfHostedProfile.endpoint,
        status: "invalid_origin",
        checkedAt: "2030-01-01T00:00:00.000Z",
        failureCode: null
      })
    ).toThrow("connectivity_status_failure_mismatch");
    expect(() =>
      connectivityValidationViewSchema.parse({
        schemaVersion: "deployment-target-draft/v1",
        target: deploymentTarget,
        endpoint: selfHostedProfile.endpoint,
        status: "invalid_tls",
        checkedAt: "2030-01-01T00:00:00.000Z",
        failureCode: "connection_failed"
      })
    ).toThrow("connectivity_status_failure_mismatch");
    expect(() =>
      deploymentGuidanceViewSchema.parse({
        ...guidance,
        handoff: { ...guidance.handoff, preview: "docker compose up -d" }
      })
    ).toThrow();
  });
});
