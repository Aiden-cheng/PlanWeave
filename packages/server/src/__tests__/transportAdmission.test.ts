import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseServerConfig } from "../config.js";
import {
  createTransportAdmissionPolicy,
  humanNetworkTransportAllowed,
  localAdminBootstrapAllowed,
  operatorNetworkTransportAllowed
} from "../insecureTransport.js";

function tailscalePolicy() {
  const advertisedOrigin = "https://planweave.example.ts.net";
  return createTransportAdmissionPolicy(
    parseServerConfig({
      version: "server-config/v2",
      transport: {
        mode: "tailscale_https",
        listener: { protocol: "http", host: "127.0.0.1", port: 7_443 },
        advertisedOrigin
      },
      deployment: {
        topology: "tailscale_https",
        serverOrigin: advertisedOrigin,
        allowedClientOrigins: [advertisedOrigin],
        tlsTrust: "system_ca"
      },
      allowedClientOrigins: [advertisedOrigin],
      dataDirectory: resolve(".tmp/transport-admission-test"),
      trustedProjects: [
        {
          workspaceId: "workspace-test",
          projectId: "project-test",
          canvasId: "canvas-test",
          projectRoot: resolve(".tmp/transport-admission-project")
        }
      ],
      operatorCredentials: [
        {
          operatorId: "operator-test",
          tokenSha256: "a".repeat(64),
          projectIds: [],
          serverAdmin: true
        }
      ]
    })
  );
}

describe("transport admission policy", () => {
  it("accepts TLS and only loopback HTTP for a Tailscale Serve backend", () => {
    const policy = tailscalePolicy();

    expect(
      humanNetworkTransportAllowed({ encrypted: true, remoteAddress: "203.0.113.5" }, policy)
    ).toBe(true);
    expect(humanNetworkTransportAllowed({ remoteAddress: "127.0.0.1" }, policy)).toBe(true);
    expect(humanNetworkTransportAllowed({ remoteAddress: "::ffff:127.0.0.1" }, policy)).toBe(true);
    expect(humanNetworkTransportAllowed({ remoteAddress: "192.168.1.20" }, policy)).toBe(false);
    expect(operatorNetworkTransportAllowed({ remoteAddress: "10.0.0.2" }, policy)).toBe(false);
  });

  it("does not let proxy-visible loopback grant local owner bootstrap", () => {
    const policy = tailscalePolicy();

    expect(localAdminBootstrapAllowed({ remoteAddress: "127.0.0.1" }, policy)).toBe(false);
    expect(
      localAdminBootstrapAllowed({ encrypted: true, remoteAddress: "127.0.0.1" }, policy)
    ).toBe(false);
  });

  it("ignores forwarded identity and transport headers by construction", () => {
    const policy = tailscalePolicy();
    const socket = { remoteAddress: "192.168.1.20" };
    const forgedHeaders = {
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "planweave.example.ts.net"
    };

    expect(forgedHeaders["x-forwarded-proto"]).toBe("https");
    expect(humanNetworkTransportAllowed(socket, policy)).toBe(false);
    expect(localAdminBootstrapAllowed(socket, policy)).toBe(false);
  });
});
