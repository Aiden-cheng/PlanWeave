/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { CollaborationConnectForm } from "../renderer/team/CollaborationConnectForm";
import { CollaborationDiagnosticsDetails } from "../renderer/team/CollaborationDiagnosticsDetails";
import type { CollaborationStatus } from "../shared/collaboration";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const translator = createTranslator("en");
const diagnosticStatus: CollaborationStatus = {
  activeProfileId: "profile-windows",
  profiles: [
    {
      profileId: "profile-windows",
      displayName: "Windows member",
      serverBaseUrl: "http://192.168.123.23:62060/",
      projectId: "project-1",
      allowInsecureTransport: true,
      hasDeviceCredential: true,
      deviceCredentialPersistence: "persisted",
      deviceCredentialId: "device-1",
      humanPrincipalId: "human-1",
      updatedAt: "2030-01-01T00:00:00.000Z"
    }
  ],
  credentialStorage: "available",
  nonPersistenceWarning: null,
  session: {
    phase: "connecting",
    activeProfileId: "profile-windows",
    detail: "observer:reconnecting:attempt=3:delay_ms=2000",
    lastErrorCode: null,
    lastErrorMessage: null
  },
  workspaceConnection: {
    schemaVersion: "workspace-setup/v1",
    status: "local_only",
    profile: null,
    workspaceId: null,
    workspaceDisplayName: null,
    connectedAt: null,
    error: null
  },
  workspacePicker: {
    schemaVersion: "workspace-setup/v1",
    items: [],
    nextCursor: null
  },
  updatedAt: "2030-01-01T00:00:03.000Z"
};

afterEach(() => {
  vi.unstubAllEnvs();
  cleanupRendererTestEnvironment();
});

describe("collaboration diagnostics visibility", () => {
  it("does not render member diagnostics in a production build", () => {
    vi.stubEnv("PROD", true);

    render(
      <CollaborationDiagnosticsDetails
        report="internal connection diagnostics"
        t={translator}
        testIdPrefix="people-member-diagnostics"
      />
    );

    expect(screen.queryByTestId("people-member-diagnostics")).not.toBeInTheDocument();
  });

  it("does not render connection diagnostics in a production build", () => {
    vi.stubEnv("PROD", true);

    render(
      <CollaborationConnectForm
        api={null}
        status={diagnosticStatus}
        t={translator}
        fixedMode="connect"
      />
    );

    expect(screen.queryByTestId("people-connection-diagnostics")).not.toBeInTheDocument();
  });
});
