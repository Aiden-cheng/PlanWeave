/**
 * Opt-in authenticated VPS / TLS e2e gate.
 *
 * PLANWEAVE_VPS_E2E=1             soft gate (missing preconditions → skip)
 * PLANWEAVE_VPS_E2E_REQUIRE=1     hard gate (missing preconditions → fail)
 * PLANWEAVE_VPS_E2E_PROFILE=…     local-tls-fixture | remote-vps
 * PLANWEAVE_VPS_E2E_CONFIG=…      absolute path outside the repo to remote config JSON
 */

export type VpsE2eGateMode = "disabled" | "soft" | "require";

export type VpsE2eProfileId = "local-tls-fixture" | "remote-vps";

export type VpsE2eGate = {
  enabled: boolean;
  mode: VpsE2eGateMode;
  profileId: VpsE2eProfileId;
  configPath: string | null;
};

function truthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function parseProfile(value: string | undefined): VpsE2eProfileId {
  if (value === "remote-vps") return "remote-vps";
  return "local-tls-fixture";
}

export function parseVpsE2eGate(
  env: Readonly<Record<string, string | undefined>> = process.env
): VpsE2eGate {
  const profileId = parseProfile(env.PLANWEAVE_VPS_E2E_PROFILE);
  const configPath =
    typeof env.PLANWEAVE_VPS_E2E_CONFIG === "string" && env.PLANWEAVE_VPS_E2E_CONFIG.trim().length > 0
      ? env.PLANWEAVE_VPS_E2E_CONFIG.trim()
      : null;
  if (truthy(env.PLANWEAVE_VPS_E2E_REQUIRE)) {
    return { enabled: true, mode: "require", profileId, configPath };
  }
  if (truthy(env.PLANWEAVE_VPS_E2E)) {
    return { enabled: true, mode: "soft", profileId, configPath };
  }
  return { enabled: false, mode: "disabled", profileId, configPath };
}

export type VpsE2ePreconditionKind =
  | "gate_disabled"
  | "openssl_missing"
  | "bins_missing"
  | "remote_config_missing"
  | "remote_config_invalid"
  | "remote_token_missing"
  | "remote_unreachable"
  | "scenario_failed";

export type VpsE2ePreconditionDisposition = "skip" | "fail";

export type VpsE2ePrecondition = {
  kind: VpsE2ePreconditionKind;
  disposition: VpsE2ePreconditionDisposition;
  message: string;
};

export function dispositionForGate(mode: VpsE2eGateMode): VpsE2ePreconditionDisposition | "disabled" {
  if (mode === "disabled") return "disabled";
  return mode === "require" ? "fail" : "skip";
}

export function precondition(
  mode: VpsE2eGateMode,
  kind: VpsE2ePreconditionKind,
  message: string
): VpsE2ePrecondition {
  return {
    kind,
    disposition: mode === "require" ? "fail" : "skip",
    message
  };
}
