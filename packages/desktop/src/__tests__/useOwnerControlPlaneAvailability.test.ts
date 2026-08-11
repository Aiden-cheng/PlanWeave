import { describe, expect, it } from "vitest";
import type { OperatorControlStatus, OperatorProfileView } from "../shared/operatorControl";
import { deriveFleetCatalogBlockedCode } from "../renderer/hooks/useOwnerControlPlaneAvailability";

function profile(overrides: Partial<OperatorProfileView> = {}): OperatorProfileView {
  return {
    profileId: "profile-1",
    displayName: "Owner",
    serverBaseUrl: "https://example.test",
    allowInsecureTransport: false,
    hostedByThisDesktop: false,
    operatorId: "operator-1",
    hasOperatorCredential: true,
    operatorCredentialPersistence: "persisted",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function status(overrides: Partial<OperatorControlStatus> = {}): OperatorControlStatus {
  return {
    activeProfileId: "profile-1",
    profiles: [profile()],
    credentialStorage: "available",
    nonPersistenceWarning: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("deriveFleetCatalogBlockedCode", () => {
  const derive = (value: OperatorControlStatus | null) =>
    deriveFleetCatalogBlockedCode(value, { bridgeAvailable: true });

  it("returns null when the active profile has an operator credential", () => {
    expect(derive(status())).toBeNull();
  });

  it("returns operator_credential_missing when the active profile lacks a credential", () => {
    expect(
      derive(
        status({
          profiles: [
            profile({ hasOperatorCredential: false, operatorCredentialPersistence: "missing" })
          ]
        })
      )
    ).toBe("operator_credential_missing");
  });

  it("returns operator_profile_not_active when no profile is active", () => {
    expect(derive(status({ activeProfileId: null }))).toBe("operator_profile_not_active");
  });

  it("returns operator_bridge_unavailable when the bridge is unavailable", () => {
    expect(deriveFleetCatalogBlockedCode(status(), { bridgeAvailable: false })).toBe(
      "operator_bridge_unavailable"
    );
  });
});
