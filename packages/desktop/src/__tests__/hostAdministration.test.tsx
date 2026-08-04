/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { HostAdministrationSection } from "../renderer/settings/HostAdministrationSection";

const bridgeMock = vi.hoisted(() => ({
  getOperatorControlStatus: vi.fn(),
  onOperatorControlStatusChanged: vi.fn(() => () => undefined),
  upsertOperatorProfile: vi.fn(),
  removeOperatorProfile: vi.fn(),
  setActiveOperatorProfile: vi.fn(),
  clearActiveOperatorProfile: vi.fn(),
  importOperatorCredential: vi.fn(),
  clearOperatorCredential: vi.fn(),
  listOperatorHosts: vi.fn(),
  copyOperatorHostBootstrapHandoff: vi.fn(),
  copyOperatorMemberSetupCode: vi.fn(),
  revokeOperatorHost: vi.fn(),
  getOperatorLocalAgentHostStatus: vi.fn(),
  registerOperatorLocalAgentHost: vi.fn(),
  enrollOperatorLocalAgentHostFromClipboard: vi.fn()
}));

vi.mock("../renderer/bridge", () => ({
  collaborationBridge: null,
  operatorControlBridge: bridgeMock
}));

const status = () => ({
  profiles: [
    {
      profileId: "profile-a",
      displayName: "Production admin",
      serverBaseUrl: "https://server.example/",
      allowInsecureTransport: false,
      endpoint: {
        topology: "public_https" as const,
        serverOrigin: "https://server.example",
        allowedClientOrigins: ["https://server.example"],
        tlsTrust: "system_ca" as const
      },
      operatorId: "operator-a",
      hasOperatorCredential: true,
      operatorCredentialPersistence: "persisted" as const,
      updatedAt: "2030-01-01T00:00:00.000Z",
      workspaceConnection: {
        schemaVersion: "workspace-setup/v1",
        status: "local_only",
        profile: null,
        workspaceId: null,
        workspaceDisplayName: null,
        connectedAt: null,
        error: null
      },
      workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null }
    }
  ],
  activeProfileId: "profile-a",
  credentialStorage: "available" as const,
  nonPersistenceWarning: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  updatedAt: "2030-01-01T00:00:00.000Z",
  workspaceConnection: {
    schemaVersion: "workspace-setup/v1",
    status: "local_only",
    profile: null,
    workspaceId: null,
    workspaceDisplayName: null,
    connectedAt: null,
    error: null
  },
  workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null }
});

const host = {
  id: "host-1",
  workspaceId: "workspace-a",
  displayName: "Build Host",
  capabilities: ["linux.x64", "codex"],
  capacity: 4,
  online: false,
  availability: { status: "unavailable" as const, reason: "offline" as const },
  lastSeenAt: undefined,
  credentialExpiresAt: "2030-01-02T00:00:00.000Z"
};

beforeEach(() => {
  bridgeMock.getOperatorControlStatus.mockResolvedValue(status());
  bridgeMock.listOperatorHosts.mockResolvedValue({ items: [host], nextCursor: null });
  bridgeMock.copyOperatorHostBootstrapHandoff.mockResolvedValue({
    state: "ready",
    workspaceId: "workspace-a",
    expiresAt: "2030-01-01T00:15:00.000Z",
    copiedAt: "2030-01-01T00:00:00.000Z",
    commandPreview: "planweave agent-host enroll <handoff>"
  });
  bridgeMock.copyOperatorMemberSetupCode.mockResolvedValue({
    state: "ready",
    workspaceId: "workspace-a",
    expiresAt: "2030-01-01T01:00:00.000Z",
    copiedAt: "2030-01-01T00:00:00.000Z"
  });
  bridgeMock.revokeOperatorHost.mockResolvedValue({
    ...host,
    revokedAt: "2030-01-01T00:01:00.000Z"
  });
  bridgeMock.getOperatorLocalAgentHostStatus.mockResolvedValue({
    supported: true,
    state: "not_registered",
    agents: [
      {
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Codex",
        detected: true,
        exposed: false,
        ready: false
      }
    ]
  });
  bridgeMock.registerOperatorLocalAgentHost.mockResolvedValue({
    supported: true,
    state: "ready",
    workspaceId: "workspace-a",
    background: "running",
    agents: [
      {
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Codex",
        detected: true,
        exposed: true,
        ready: true
      }
    ]
  });
  bridgeMock.enrollOperatorLocalAgentHostFromClipboard.mockResolvedValue({
    supported: true,
    state: "ready",
    workspaceId: "workspace-a",
    background: "running",
    agents: [
      {
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Codex",
        detected: true,
        exposed: true,
        ready: true
      }
    ]
  });
  bridgeMock.upsertOperatorProfile.mockResolvedValue(status());
  bridgeMock.setActiveOperatorProfile.mockResolvedValue(status());
  bridgeMock.importOperatorCredential.mockResolvedValue(status());
  bridgeMock.clearOperatorCredential.mockResolvedValue(status());
  bridgeMock.removeOperatorProfile.mockResolvedValue({
    ...status(),
    profiles: [],
    activeProfileId: null
  });
  bridgeMock.clearActiveOperatorProfile.mockResolvedValue({ ...status(), activeProfileId: null });
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true)
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.values(bridgeMock).forEach((mock) => {
    if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
  });
});

describe("Agent Host settings", () => {
  it("shows only user-facing device and agent information", async () => {
    const { container } = render(<HostAdministrationSection t={createTranslator("en")} />);

    expect(await screen.findByTestId("host-administration")).toBeInTheDocument();
    expect(screen.getByTestId("deployment-connection")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Tailscale private network/ })).toBeInTheDocument();
    expect(container.querySelector('[data-slot="card"]')).not.toBeInTheDocument();
    expect(await screen.findByTestId("host-availability-status-host-1")).toHaveTextContent(
      "Offline"
    );
    expect(screen.getByText("Build Host")).toBeInTheDocument();

    for (const internalValue of [
      "profile-a",
      "workspace-a",
      "host-1",
      "linux.x64",
      "server-admin",
      "Operator credential",
      "Profile ID",
      "Server URL",
      "Workspace mapping",
      "ACP profiles"
    ]) {
      expect(screen.queryByText(internalValue, { exact: false })).not.toBeInTheDocument();
    }
    expect(screen.queryByTestId("host-admin-profiles")).not.toBeInTheDocument();
    expect(screen.queryByTestId("host-admin-credential")).not.toBeInTheDocument();
    expect(screen.queryByTestId("host-admin-inventory")).not.toBeInTheDocument();
    expect(screen.queryByTestId("host-admin-member-setup")).not.toBeInTheDocument();
  });

  it("shows friendly agent names while keeping profile IDs and capabilities private", async () => {
    bridgeMock.listOperatorHosts.mockResolvedValueOnce({
      items: [
        {
          ...host,
          online: true,
          capabilities: ["linux.x64", "acp.codex"],
          availability: { status: "available", reason: null },
          readinessObservation: {
            workspaceMappings: [{ workspaceId: "workspace-a", status: "ready" }],
            acpProfiles: [
              {
                profileId: "codex-acp",
                agentId: "codex",
                displayName: "Codex",
                status: "ready",
                capabilities: ["acp.codex"]
              }
            ]
          }
        }
      ],
      nextCursor: null
    });

    render(<HostAdministrationSection t={createTranslator("en")} />);

    expect(await screen.findByTestId("host-availability-status-host-1")).toHaveTextContent(
      "Online"
    );
    expect(screen.getByText("Codex", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("codex-acp", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("acp.codex", { exact: true })).not.toBeInTheDocument();
  });

  it("uses the Server availability result but explains the action without protocol jargon", async () => {
    bridgeMock.listOperatorHosts.mockResolvedValueOnce({
      items: [
        {
          ...host,
          online: true,
          availability: { status: "unavailable", reason: "capability_mismatch" }
        }
      ],
      nextCursor: null
    });

    render(<HostAdministrationSection t={createTranslator("en")} />);

    expect(await screen.findByTestId("host-availability-status-host-1")).toHaveTextContent(
      "Update required"
    );
    expect(screen.getByText("Update the agents shared by the target device.")).toBeInTheDocument();
    expect(screen.queryByText(/capability|ACP|preset|heartbeat/i)).not.toBeInTheDocument();
  });

  it("copies enrollment details without displaying commands, workspace IDs, or secrets", async () => {
    const user = userEvent.setup();
    render(<HostAdministrationSection t={createTranslator("en")} />);
    await screen.findByTestId("host-administration");

    await user.click(screen.getByTestId("host-admin-create-grant"));
    expect(await screen.findByTestId("host-admin-grant-once")).toBeInTheDocument();
    expect(bridgeMock.copyOperatorHostBootstrapHandoff).toHaveBeenCalledWith({
      profileId: "profile-a",
      request: {
        expiresAt: expect.any(String),
        credentialExpiresAt: expect.any(String)
      }
    });
    expect(
      screen.queryByText(/planweave agent-host enroll|workspace-a|pw_enroll_/i)
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("host-admin-bootstrap-error")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("host-admin-close-grant"));
    expect(screen.queryByTestId("host-admin-grant-once")).not.toBeInTheDocument();
  });

  it("registers this Windows computer with an explicitly selected Agent", async () => {
    const user = userEvent.setup();
    render(<HostAdministrationSection t={createTranslator("en")} />);
    const checkbox = await screen.findByTestId("host-admin-local-agent-codex-acp");

    await user.click(checkbox);
    await user.click(screen.getByTestId("host-admin-register-local"));

    expect(bridgeMock.registerOperatorLocalAgentHost).toHaveBeenCalledWith({
      profileId: "profile-a",
      request: {
        expiresAt: expect.any(String),
        credentialExpiresAt: expect.any(String)
      },
      exposedProfileIds: ["codex-acp"]
    });
    expect(await screen.findByTestId("host-admin-local-status")).toHaveTextContent(
      "This computer is connected"
    );
  });

  it("enrolls from the main-owned clipboard without an administrative connection", async () => {
    const user = userEvent.setup();
    bridgeMock.getOperatorControlStatus.mockResolvedValue({
      ...status(),
      profiles: [],
      activeProfileId: null
    });
    render(<HostAdministrationSection t={createTranslator("en")} />);
    const checkbox = await screen.findByTestId("host-admin-local-agent-codex-acp");

    await user.click(checkbox);
    await user.click(screen.getByTestId("host-admin-enroll-local-clipboard"));

    expect(bridgeMock.enrollOperatorLocalAgentHostFromClipboard).toHaveBeenCalledWith({
      exposedProfileIds: ["codex-acp"]
    });
    expect(await screen.findByTestId("host-admin-local-status")).toHaveTextContent(
      "This computer is connected"
    );
  });

  it("offers clipboard registration when the current Server cannot register directly", async () => {
    const customCaStatus = status();
    bridgeMock.getOperatorControlStatus.mockResolvedValue({
      ...customCaStatus,
      profiles: customCaStatus.profiles.map((profile) => ({
        ...profile,
        endpoint: profile.endpoint
          ? { ...profile.endpoint, tlsTrust: "configured_ca" as const }
          : undefined
      }))
    });

    render(<HostAdministrationSection t={createTranslator("en")} />);

    expect(await screen.findByTestId("host-admin-local-custom-ca")).toHaveTextContent(
      "does not support one-click registration"
    );
    expect(screen.queryByText(/custom CA|configured_ca/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("host-admin-register-local")).not.toBeInTheDocument();
    expect(screen.getByTestId("host-admin-enroll-local-clipboard")).toBeInTheDocument();
  });

  it("requires confirmation before removing a remote device", async () => {
    const user = userEvent.setup();
    render(<HostAdministrationSection t={createTranslator("en")} />);
    await screen.findByTestId("host-availability-host-1");

    await user.click(screen.getByTestId("host-admin-revoke-host-1"));
    expect(bridgeMock.revokeOperatorHost).toHaveBeenCalledWith({
      profileId: "profile-a",
      hostId: "host-1"
    });
    await waitFor(() =>
      expect(screen.queryByTestId("host-availability-host-1")).not.toBeInTheDocument()
    );
  });

  it("maps administrative errors to a user-facing permission message", async () => {
    bridgeMock.listOperatorHosts.mockRejectedValueOnce(new Error("operator_admin_required"));
    render(<HostAdministrationSection t={createTranslator("en")} />);

    expect(
      await screen.findByText("Your account cannot manage remote devices.")
    ).toBeInTheDocument();
  });
});
