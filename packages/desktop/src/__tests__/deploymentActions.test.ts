import { describe, expect, it } from "vitest";
import { DeploymentActions } from "../main/collaboration/deploymentActions.js";

const profile = {
  schemaVersion: "deployment-connection/v1" as const,
  profileId: "profile-001",
  displayName: "Workspace",
  workspace: { workspaceId: "workspace-001" },
  endpoint: {
    topology: "public_https" as const,
    serverOrigin: "https://collab.example.test/",
    allowedClientOrigins: ["https://collab.example.test/"],
    tlsTrust: "system_ca" as const
  },
  capabilities: [
    "workspace_connection",
    "deployment_guidance",
    "connectivity_validation",
    "agent_host_availability"
  ]
};

function request(
  action: "request_deployment_guidance" | "copy_supported_compose_handoff" | "validate_connectivity"
) {
  return { action, workspace: profile.workspace, profile };
}

describe("DeploymentActions", () => {
  it("generates and copies only the fixed supported Compose handoff", () => {
    const copied: string[] = [];
    const actions = new DeploymentActions({
      writeClipboard: (value) => copied.push(value),
      now: () => new Date("2030-01-01T00:00:00.000Z")
    });
    const guidance = actions.guidance(request("request_deployment_guidance"));
    expect(guidance.handoff.preview).toContain("--detach --wait");
    expect(guidance.handoff.projectsMountTarget).toBe("/var/lib/planweave/projects");
    expect(actions.copyComposeHandoff(request("copy_supported_compose_handoff"))).toEqual({
      state: "copied",
      copiedAt: "2030-01-01T00:00:00.000Z"
    });
    expect(copied).toEqual([guidance.handoff.preview]);
  });

  it("keeps loopback out of the Compose handoff", () => {
    const actions = new DeploymentActions();
    const loopback = {
      ...profile,
      endpoint: {
        topology: "loopback_http" as const,
        serverOrigin: "http://127.0.0.1:7443/",
        allowedClientOrigins: ["http://127.0.0.1:7443/"],
        tlsTrust: "not_applicable" as const
      }
    };
    expect(
      actions.guidance({
        action: "request_deployment_guidance",
        workspace: loopback.workspace,
        profile: loopback
      }).handoff.state
    ).toBe("not_applicable");
    expect(() =>
      actions.copyComposeHandoff({
        action: "copy_supported_compose_handoff",
        workspace: loopback.workspace,
        profile: loopback
      })
    ).toThrow("deployment_compose_handoff_not_supported");
  });

  it("reports static origin configuration failures without claiming a WebSocket probe", async () => {
    const actions = new DeploymentActions({
      request: async () => new Response(null, { status: 200 })
    });
    const mismatched = {
      ...profile,
      endpoint: { ...profile.endpoint, allowedClientOrigins: ["https://desktop.example.test/"] }
    };
    await expect(
      actions.validateConnectivity({
        action: "validate_connectivity",
        workspace: mismatched.workspace,
        profile: mismatched
      })
    ).resolves.toMatchObject({
      status: "invalid_origin",
      failureCode: "allowed_client_origin_missing"
    });
  });
});
