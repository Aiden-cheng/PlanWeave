/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { DeploymentConnectionCard } from "../renderer/settings/DeploymentConnectionCard";

const collaborationBridge = vi.hoisted(() => ({
  getActiveWorkspaceConnection: vi.fn().mockResolvedValue({ profile: null, workspaceId: null }),
  getDesktopServerExposure: vi.fn().mockResolvedValue({
    mode: "local_only",
    topology: "loopback_http",
    lifecycle: "ready",
    advertisedOrigin: null,
    errorCode: null,
    canActivate: true,
    canInvite: true
  }),
  setDesktopServerExposureMode: vi.fn(),
  getDeploymentGuidance: vi.fn().mockResolvedValue({
    handoff: { state: "unsupported", reason: "not_available" }
  }),
  validateDeploymentConnectivity: vi.fn(),
  copyDeploymentComposeHandoff: vi.fn(),
  exportDeploymentComposeBundle: vi.fn()
}));

vi.mock("../renderer/bridge", () => ({ collaborationBridge }));

describe("DeploymentConnectionCard", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps custom HTTPS guidance available without an authenticated Workspace", async () => {
    const user = userEvent.setup();
    render(<DeploymentConnectionCard t={createTranslator("en")} />);

    await user.selectOptions(screen.getByTestId("deployment-topology"), "custom_https");
    await user.type(screen.getByTestId("deployment-display-name"), "Hosted Server");
    await user.type(screen.getByTestId("deployment-origin"), "https://server.example.test");

    expect(screen.getByRole("button", { name: "Review handoff" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Validate endpoint" })).toBeEnabled();
  });

  it("passes an explicit LAN HTTPS topology and TLS trust for a non-standard port", async () => {
    const user = userEvent.setup();
    render(<DeploymentConnectionCard t={createTranslator("en")} />);

    await user.selectOptions(screen.getByTestId("deployment-topology"), "custom_https");
    await user.type(screen.getByTestId("deployment-display-name"), "LAN Server");
    await user.type(screen.getByTestId("deployment-origin"), "https://192.168.1.20:7443");
    await user.selectOptions(screen.getByTestId("deployment-custom-topology"), "lan_https");
    await user.selectOptions(screen.getByTestId("deployment-tls-trust"), "configured_ca");
    await user.click(screen.getByRole("button", { name: "Review handoff" }));

    expect(collaborationBridge.getDeploymentGuidance).toHaveBeenCalledWith({
      action: "request_deployment_guidance",
      target: expect.objectContaining({
        endpoint: {
          topology: "lan_https",
          serverOrigin: "https://192.168.1.20:7443/",
          allowedClientOrigins: ["https://192.168.1.20:7443/"],
          tlsTrust: "configured_ca"
        }
      })
    });
  });

  it("activates Tailscale without asking the renderer for an Origin", async () => {
    const user = userEvent.setup();
    collaborationBridge.setDesktopServerExposureMode.mockResolvedValue({
      mode: "tailscale_private",
      topology: "tailscale_https",
      lifecycle: "ready",
      advertisedOrigin: "https://planweave.example.ts.net/",
      errorCode: null,
      canActivate: true,
      canInvite: true
    });
    render(<DeploymentConnectionCard t={createTranslator("en")} />);
    await waitFor(() => expect(collaborationBridge.getDesktopServerExposure).toHaveBeenCalled());

    await user.selectOptions(screen.getByTestId("deployment-topology"), "tailscale_private");
    expect(screen.queryByTestId("deployment-origin")).not.toBeInTheDocument();
    expect(screen.queryByTestId("deployment-display-name")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Apply connection mode" }));

    expect(collaborationBridge.setDesktopServerExposureMode).toHaveBeenCalledWith({
      mode: "tailscale_private"
    });
    expect(screen.getByTestId("deployment-advertised-origin")).toHaveTextContent(
      "https://planweave.example.ts.net/"
    );
  });

  it("labels raw LAN HTTP as an advanced separate option", () => {
    render(<DeploymentConnectionCard t={createTranslator("en")} />);

    expect(screen.getByRole("option", { name: "LAN HTTP (advanced/development)" })).toHaveValue(
      "lan_http"
    );
  });
});
