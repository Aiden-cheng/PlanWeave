import { describe, expect, it } from "vitest";
import { buildHostBootstrapHandoff } from "../main/operatorControl/hostBootstrapHandoff.js";

describe("main-owned Host bootstrap handoff", () => {
  it("contains the enrollment code only in the clipboard payload", () => {
    const enrollmentCode = `pw_enroll_${"A".repeat(43)}`;
    const handoff = buildHostBootstrapHandoff(
      {
        profileId: "profile-a",
        displayName: "Operator A",
        serverBaseUrl: "https://operator.example.test/",
        allowInsecureTransport: false
      },
      {
        profileId: "profile-a",
        request: {
          expiresAt: "2030-01-01T00:15:00.000Z",
          credentialExpiresAt: "2030-01-02T00:00:00.000Z"
        },
        bootstrap: {
          configPath: "/etc/planweave/agent-host.json",
          dataDirectory: "/var/lib/planweave-agent-host",
          workspaceRoot: "/var/lib/planweave-agent-host/workspaces",
          host: { displayName: "Host A", capacity: 1, capabilities: ["linux.x64"] }
        }
      },
      { enrollmentCode, workspaceId: "workspace-a", expiresAt: "2030-01-01T00:15:00.000Z" }
    );

    expect(handoff).toContain(`--code '${enrollmentCode}'`);
    expect(handoff).toContain("base64 --decode > '/etc/planweave/agent-host.json'");
    expect(handoff).toContain("planweave-agent-host run");
  });
});
