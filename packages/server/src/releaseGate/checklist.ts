/**
 * Release-facing live gate checklist.
 *
 * Three tiers are intentionally separate. A skipped live tier is never treated
 * as a pass for the release readiness verdict.
 */

export type ReleaseGateTierId =
  | "deterministic_process_suite"
  | "local_real_acp_compatibility"
  | "remote_authenticated_vps";

export type ReleaseGateTierRequirement =
  | "required_ci"
  | "required_supported_version_release"
  | "required_pre_release_evidence";

export type ReleaseGateTierDefinition = {
  id: ReleaseGateTierId;
  requirement: ReleaseGateTierRequirement;
  title: string;
  summary: string;
  /** Sanitized operator command; no secrets or host-specific endpoints. */
  command: string;
  environment: readonly string[];
  evidenceVersion: string | null;
  ownership: string;
  /** Default max age for accepted evidence (hours). null = N/A for CI suite. */
  evidenceMaxAgeHours: number | null;
};

export const RELEASE_GATE_EVIDENCE_MAX_AGE_HOURS = 336 as const; // 14 days

export const RELEASE_GATE_TIERS: readonly ReleaseGateTierDefinition[] = [
  {
    id: "deterministic_process_suite",
    requirement: "required_ci",
    title: "Deterministic multi-process suite",
    summary:
      "Required CI. Real Server + Host processes with mock ACP; no provider login, no remote VPS, no secrets.",
    command:
      "pnpm exec vitest run packages/server/src/__tests__/realProcessAcpHarness.test.ts packages/server/src/__tests__/realProcessRemoteBlockLifecycle.test.ts packages/server/src/__tests__/realProcessCrashReplayMatrix.test.ts packages/server/src/__tests__/realProcessAuthorizationMatrix.test.ts",
    environment: [],
    evidenceVersion: "planweave.release-gate.deterministic/v1",
    ownership: "CI / any developer workstation with the monorepo test suite",
    evidenceMaxAgeHours: null
  },
  {
    id: "local_real_acp_compatibility",
    requirement: "required_supported_version_release",
    title: "Local real ACP compatibility",
    summary:
      "Required before declaring a supported ACP Agent version. Host-local public ACP only; soft skip is not a release pass.",
    command:
      "PLANWEAVE_REAL_ACP_REQUIRE=1 planweave-agent-host real-acp-smoke --require --evidence <sanitized-path>",
    environment: ["PLANWEAVE_REAL_ACP=1", "PLANWEAVE_REAL_ACP_REQUIRE=1", "PLANWEAVE_REAL_ACP_PROFILE"],
    evidenceVersion: "planweave.real-acp-host-smoke/v1",
    ownership:
      "Release operator machine with the supported ACP Agent binary and Host-local provider login/env (never committed)",
    evidenceMaxAgeHours: RELEASE_GATE_EVIDENCE_MAX_AGE_HOURS
  },
  {
    id: "remote_authenticated_vps",
    requirement: "required_pre_release_evidence",
    title: "Remote authenticated VPS path",
    summary:
      "Required pre-release evidence for the distributed path. remote-vps only counts; local-tls-fixture is not a production VPS claim. Skipped evidence is not a pass.",
    command:
      "PLANWEAVE_VPS_E2E_REQUIRE=1 planweave-server vps-e2e --require --profile remote-vps --evidence <sanitized-path>",
    environment: [
      "PLANWEAVE_VPS_E2E=1",
      "PLANWEAVE_VPS_E2E_REQUIRE=1",
      "PLANWEAVE_VPS_E2E_PROFILE=remote-vps",
      "PLANWEAVE_VPS_E2E_CONFIG",
      "PLANWEAVE_VPS_OPERATOR_TOKEN"
    ],
    evidenceVersion: "planweave.vps-authenticated-e2e/v1",
    ownership:
      "Release operator disposable VPS and secret store (endpoints, TLS material, enrollment tokens, SSH). Never stored in the repository.",
    evidenceMaxAgeHours: RELEASE_GATE_EVIDENCE_MAX_AGE_HOURS
  }
] as const;

export type RollbackCheckDefinition = {
  id: string;
  title: string;
  required: boolean;
  constraint: string;
};

export const RELEASE_GATE_ROLLBACK_CHECKS: readonly RollbackCheckDefinition[] = [
  {
    id: "state_backup",
    title: "State backup before upgrade",
    required: true,
    constraint:
      "Backup Server dataDirectory and Host dataDirectory (SQLite + credentials) before install upgrade. Rollback restores these backups; it must not DELETE databases to 'start clean'."
  },
  {
    id: "install_upgrade",
    title: "Install upgrade path",
    required: true,
    constraint:
      "Upgrade Server and Agent Host together within the same package major. Protocol version must remain agentHostProtocolVersion. Verify /version and Host status after upgrade."
  },
  {
    id: "credential_rotation",
    title: "Credential rotation",
    required: true,
    constraint:
      "Rotate Host credentials with planweave-agent-host enroll --replace and a fresh one-time enrollment grant. Revoke prior grants; never reuse enrollment codes."
  },
  {
    id: "credential_revocation",
    title: "Credential revocation",
    required: true,
    constraint:
      "On Host replace or compromise: server-side POST /api/v1/hosts/:hostId/revoke and Host-local planweave-agent-host revoke. Confirm disconnect and no further dispatch acceptance."
  },
  {
    id: "graceful_downgrade",
    title: "Graceful downgrade / rollback",
    required: true,
    constraint:
      "Downgrade only within the same package major after restoring state backups. Cross-major rollback requires a coordinated cutover. Do not reset databases."
  },
  {
    id: "no_silent_rerun",
    title: "No silent rerun of interrupted Blocks",
    required: true,
    constraint:
      "Rollback/restart must not silently re-dispatch interrupted Blocks. Use explicit operator lifecycle actions (resume_same_session, retry_new_attempt, cancel, fail, block) only."
  },
  {
    id: "cleanup",
    title: "Harness and credential cleanup",
    required: true,
    constraint:
      "After live evidence collection: remove disposable harness workspaces, revoke one-time enrollment materials, and confirm evidence JSON contains digests/ids only."
  }
] as const;

export function tierById(id: ReleaseGateTierId): ReleaseGateTierDefinition {
  const tier = RELEASE_GATE_TIERS.find((item) => item.id === id);
  if (!tier) throw new Error(`release_gate_tier_unknown:${id}`);
  return tier;
}
