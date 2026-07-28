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
  revokeOperatorHost: vi.fn()
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
    copiedAt: "2030-01-01T00:00:00.000Z"
  });
  bridgeMock.revokeOperatorHost.mockResolvedValue({
    ...host,
    revokedAt: "2030-01-01T00:01:00.000Z"
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

describe("Host administration surface", () => {
  it("keeps Host administration separate and shows only redacted credential state", async () => {
    render(<HostAdministrationSection t={createTranslator("en")} />);

    expect(await screen.findByTestId("host-administration")).toBeInTheDocument();
    expect(await screen.findByTestId("host-availability-status-host-1")).toHaveTextContent(
      "Unavailable: offline"
    );
    expect(screen.getByText("Credential available · OS vault")).toBeInTheDocument();
    expect(screen.getByText("linux.x64, codex")).toBeInTheDocument();
    expect(screen.queryByText(/operator_a_token|Bearer/i)).not.toBeInTheDocument();
  });

  it("shows the Server-projected native Host readiness without target-machine details", async () => {
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
      "Available"
    );
    expect(screen.queryByText(/\/var\/lib|codex-acp --|PATH=/)).not.toBeInTheDocument();
  });

  it("renders the Server availability result instead of recomputing readiness in the renderer", async () => {
    bridgeMock.listOperatorHosts.mockResolvedValueOnce({
      items: [
        {
          ...host,
          online: true,
          capabilities: ["linux.x64", "acp.codex"],
          availability: { status: "unavailable", reason: "capability_mismatch" },
          readinessObservation: {
            workspaceMappings: [{ workspaceId: "workspace-a", status: "ready" }],
            acpProfiles: [
              {
                profileId: "codex-acp",
                agentId: "codex",
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
      "Unavailable: capability mismatch"
    );
    expect(
      screen.getByText(/Restart the Host after the configured ACP preset/i)
    ).toBeInTheDocument();
  });

  it("keeps enrollment secrets out of renderer state while showing redacted main-owned handoff status", async () => {
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
      },
      bootstrap: {
        configPath: "/etc/planweave/agent-host.json",
        dataDirectory: "/var/lib/planweave-agent-host",
        workspaceRoot: "/var/lib/planweave-agent-host/workspaces",
        workspacePath: "project",
        acpProfilePreset: "codex-acp",
        host: { displayName: "Production admin", capacity: 1, capabilities: ["linux.x64"] }
      }
    });
    expect(screen.queryByTestId("host-admin-enrollment-secret")).not.toBeInTheDocument();
    expect(screen.queryByTestId("host-admin-bootstrap-config")).not.toBeInTheDocument();
    expect(screen.queryByTestId("host-admin-bootstrap-command")).not.toBeInTheDocument();
    expect(JSON.stringify(bridgeMock.copyOperatorHostBootstrapHandoff.mock.calls)).not.toContain(
      "pw_enroll_"
    );

    await user.click(screen.getByTestId("host-admin-close-grant"));
    expect(screen.queryByTestId("host-admin-grant-once")).not.toBeInTheDocument();
  });

  it("requires confirmation before revoking and reflects revoked state", async () => {
    const user = userEvent.setup();
    render(<HostAdministrationSection t={createTranslator("en")} />);
    await screen.findByTestId("host-admin-host-host-1");

    await user.click(screen.getByTestId("host-admin-revoke-host-1"));
    expect(bridgeMock.revokeOperatorHost).toHaveBeenCalledWith({
      profileId: "profile-a",
      hostId: "host-1"
    });
    await waitFor(() =>
      expect(screen.getByTestId("host-admin-host-status-host-1")).toHaveAttribute(
        "data-status",
        "revoked"
      )
    );
  });

  it("requests a main-process clipboard import without accepting the token", async () => {
    const user = userEvent.setup();
    render(<HostAdministrationSection t={createTranslator("en")} />);
    await screen.findByTestId("host-administration");

    expect(screen.queryByTestId("host-admin-operator-token")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("host-admin-import-credential"));

    expect(bridgeMock.importOperatorCredential).toHaveBeenCalledWith({
      profileId: "profile-a"
    });
  });

  it("maps a plain IPC error code to an honest forbidden state", async () => {
    bridgeMock.listOperatorHosts.mockRejectedValueOnce(new Error("operator_admin_required"));
    render(<HostAdministrationSection t={createTranslator("en")} />);

    expect(
      await screen.findByText("This operator is not allowed to administer Hosts.")
    ).toBeInTheDocument();
  });
});
