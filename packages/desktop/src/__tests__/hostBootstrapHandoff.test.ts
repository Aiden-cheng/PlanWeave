import { describe, expect, it } from "vitest";
import { parseAgentHostSetupHandoff } from "@planweave-ai/agent-host-protocol";
import { buildHostBootstrapHandoff } from "../main/operatorControl/hostBootstrapHandoff.js";

describe("main-owned Host setup handoff", () => {
  it("copies one portable command with the validated advertised endpoint", () => {
    const enrollmentCode = `pw_enroll_${"A".repeat(43)}`;
    const command = buildHostBootstrapHandoff(
      {
        profileId: "profile-a",
        displayName: "Operator A",
        serverBaseUrl: "https://planweave.tail1234.ts.net/",
        allowInsecureTransport: false,
        endpoint: {
          topology: "private_https",
          serverOrigin: "https://planweave.tail1234.ts.net",
          allowedClientOrigins: ["https://planweave.tail1234.ts.net"],
          tlsTrust: "system_ca"
        }
      },
      {
        profileId: "profile-a",
        request: {
          expiresAt: "2030-01-01T00:15:00.000Z",
          credentialExpiresAt: "2030-01-02T00:00:00.000Z"
        }
      },
      { enrollmentCode, workspaceId: "workspace-a", expiresAt: "2030-01-01T00:15:00.000Z" }
    );

    expect(command).toMatch(/^planweave agent-host enroll planweave-agent-host-setup:/);
    const encoded = command.slice("planweave agent-host enroll ".length);
    expect(parseAgentHostSetupHandoff(encoded, new Date("2029-01-01"))).toMatchObject({
      endpoint: { topology: "private_https", tlsTrust: "system_ca" },
      workspaceId: "workspace-a",
      enrollmentCode
    });
    expect(command).not.toMatch(/\/etc\/|\/var\/lib|--config|--code|base64 --decode/);
  });

  it("rejects profiles without a Main-validated endpoint", () => {
    expect(() =>
      buildHostBootstrapHandoff(
        {
          profileId: "legacy",
          displayName: "Legacy",
          serverBaseUrl: "https://server.example/",
          allowInsecureTransport: false
        },
        {
          profileId: "legacy",
          request: {
            expiresAt: "2030-01-01T00:15:00.000Z",
            credentialExpiresAt: "2030-01-02T00:00:00.000Z"
          }
        },
        {
          enrollmentCode: `pw_enroll_${"A".repeat(43)}`,
          workspaceId: "workspace-a",
          expiresAt: "2030-01-01T00:15:00.000Z"
        }
      )
    ).toThrow("operator_deployment_endpoint_required");
  });
});
