/**
 * Opt-in real ACP gate.
 *
 * PLANWEAVE_REAL_ACP=1          enable soft gate (missing preconditions → skip)
 * PLANWEAVE_REAL_ACP_REQUIRE=1  hard gate (missing preconditions → fail)
 * PLANWEAVE_REAL_ACP_PROFILE=…  optional preferred Host-local profile id
 */

export type RealAcpGateMode = "disabled" | "soft" | "require";

export type RealAcpGate = {
  enabled: boolean;
  mode: RealAcpGateMode;
  preferredProfileId: string | null;
};

function truthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function parseRealAcpGate(
  env: Readonly<Record<string, string | undefined>> = process.env
): RealAcpGate {
  const preferred =
    typeof env.PLANWEAVE_REAL_ACP_PROFILE === "string" &&
    env.PLANWEAVE_REAL_ACP_PROFILE.trim().length > 0
      ? env.PLANWEAVE_REAL_ACP_PROFILE.trim()
      : null;
  if (truthy(env.PLANWEAVE_REAL_ACP_REQUIRE)) {
    return { enabled: true, mode: "require", preferredProfileId: preferred };
  }
  if (truthy(env.PLANWEAVE_REAL_ACP)) {
    return { enabled: true, mode: "soft", preferredProfileId: preferred };
  }
  return { enabled: false, mode: "disabled", preferredProfileId: preferred };
}

export type RealAcpPreconditionKind =
  | "gate_disabled"
  | "binary_missing"
  | "binary_not_executable"
  | "profile_unsupported"
  | "launch_metadata_unavailable"
  | "auth_required"
  | "credential_missing"
  | "protocol_unsupported"
  | "preflight_failed";

export type RealAcpPreconditionDisposition = "skip" | "fail";

export type RealAcpPrecondition = {
  kind: RealAcpPreconditionKind;
  disposition: RealAcpPreconditionDisposition;
  message: string;
  profileId?: string;
};

export function dispositionForGate(
  mode: RealAcpGateMode
): RealAcpPreconditionDisposition | "disabled" {
  if (mode === "disabled") return "disabled";
  return mode === "require" ? "fail" : "skip";
}

export function precondition(
  mode: RealAcpGateMode,
  kind: RealAcpPreconditionKind,
  message: string,
  profileId?: string
): RealAcpPrecondition {
  const disposition = mode === "require" ? "fail" : "skip";
  return profileId === undefined
    ? { kind, disposition, message }
    : { kind, disposition, message, profileId };
}
