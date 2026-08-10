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
    provider: null,
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

  it("uses system trust for a private HTTPS endpoint on a non-standard port", async () => {
    const user = userEvent.setup();
    render(<DeploymentConnectionCard t={createTranslator("en")} />);

    await user.selectOptions(screen.getByTestId("deployment-topology"), "custom_https");
    await user.type(screen.getByTestId("deployment-display-name"), "LAN Server");
    await user.type(screen.getByTestId("deployment-origin"), "https://192.168.1.20:7443");
    await user.selectOptions(screen.getByTestId("deployment-custom-topology"), "private_https");
    expect(screen.queryByTestId("deployment-tls-trust")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "HTTPS certificates must be trusted by the operating system. For a private CA, install it in the system trust store first."
      )
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review handoff" }));

    expect(collaborationBridge.getDeploymentGuidance).toHaveBeenCalledWith({
      action: "request_deployment_guidance",
      target: expect.objectContaining({
        endpoint: {
          topology: "private_https",
          serverOrigin: "https://192.168.1.20:7443/",
          allowedClientOrigins: ["https://192.168.1.20:7443/"],
          tlsTrust: "system_ca"
        }
      })
    });
  });

  it("activates automatic private HTTPS without asking the renderer for an Origin", async () => {
    const user = userEvent.setup();
    const onExposureChange = vi.fn();
    collaborationBridge.setDesktopServerExposureMode.mockResolvedValue({
      mode: "private_https",
      topology: "private_https",
      provider: { id: "tailscale", displayName: "Tailscale" },
      lifecycle: "ready",
      advertisedOrigin: "https://planweave.example.ts.net/",
      errorCode: null,
      canActivate: true,
      canInvite: true
    });
    render(
      <DeploymentConnectionCard t={createTranslator("en")} onExposureChange={onExposureChange} />
    );
    await waitFor(() => expect(collaborationBridge.getDesktopServerExposure).toHaveBeenCalled());

    await user.selectOptions(screen.getByTestId("deployment-topology"), "private_https");
    expect(screen.queryByTestId("deployment-origin")).not.toBeInTheDocument();
    expect(screen.queryByTestId("deployment-display-name")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Enable this connection" }));

    expect(collaborationBridge.setDesktopServerExposureMode).toHaveBeenCalledWith({
      mode: "private_https"
    });
    expect(screen.getByTestId("deployment-advertised-origin")).toHaveTextContent(
      "https://planweave.example.ts.net/"
    );
    expect(onExposureChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "private_https", lifecycle: "ready" })
    );
  });

  it("labels raw LAN HTTP as an advanced separate option", () => {
    render(<DeploymentConnectionCard t={createTranslator("en")} />);

    expect(screen.getByRole("option", { name: "LAN HTTP (development only)" })).toHaveValue(
      "lan_http"
    );
  });

  it("supports a flat presentation without nesting another card", () => {
    const { container } = render(
      <DeploymentConnectionCard presentation="plain" t={createTranslator("en")} />
    );

    expect(screen.getByRole("heading", { name: "Remote access" })).toBeVisible();
    expect(screen.getByLabelText("Access method")).toBeVisible();
    expect(
      screen.queryByText(/Changing the connection only changes how Server is reached/)
    ).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="card"]')).not.toBeInTheDocument();
  });
});
