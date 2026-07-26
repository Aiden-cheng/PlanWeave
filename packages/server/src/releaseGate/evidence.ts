import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  PLANWEAVE_COMPATIBILITY_BOUNDS,
  assertAgentHostProtocolCompatible,
  assertMatchingPackageMajors,
  packageVersionSchema
} from "@planweave-ai/distributed-protocol";
import { serverPackageVersion } from "../packageInfo.js";
import {
  RELEASE_GATE_EVIDENCE_MAX_AGE_HOURS,
  RELEASE_GATE_ROLLBACK_CHECKS,
  RELEASE_GATE_TIERS,
  type ReleaseGateTierId,
  type RollbackCheckDefinition
} from "./checklist.js";
import { redactSensitiveText } from "../vpsE2e/redaction.js";

export const RELEASE_GATE_REPORT_VERSION = "planweave.release-gate/v1" as const;

export type TierEvaluationStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "not_provided"
  | "expired"
  | "invalid";

export type TierEvaluation = {
  tierId: ReleaseGateTierId;
  requirement: string;
  status: TierEvaluationStatus;
  /** True only when result is an actual pass for release purposes. */
  countsAsPass: boolean;
  evidenceDigest: string | null;
  diagnostic: string | null;
  observedAt: string | null;
  environmentClass: string | null;
};

export type ReleaseGateReport = {
  version: typeof RELEASE_GATE_REPORT_VERSION;
  generatedAt: string;
  serverVersion: string;
  compatibility: {
    bounds: typeof PLANWEAVE_COMPATIBILITY_BOUNDS;
    protocolCheck: { ok: boolean; code?: string; message?: string };
    packageMajorCheck: { ok: boolean; code?: string; message?: string };
    packageVersions: {
      server: string;
      agentHost: string | null;
      protocol: string | null;
    };
  };
  tiers: TierEvaluation[];
  rollback: Array<
    RollbackCheckDefinition & {
      status: "documented";
      operatorMustConfirm: true;
    }
  >;
  rules: {
    skippedLiveIsNotPass: true;
    storeOnlySanitizedSummaries: true;
    neverEmbedSecrets: true;
    evidenceMaxAgeHours: typeof RELEASE_GATE_EVIDENCE_MAX_AGE_HOURS;
  };
  ownership: {
    liveInfrastructure: string;
    ci: string;
  };
  releaseReady: {
    ci: boolean;
    supportedVersionRelease: boolean;
    preRelease: boolean;
  };
  diagnostic: string | null;
};

const tierResultSchema = z.enum(["passed", "failed", "skipped"]);

const realAcpPassedChecksSchema = z
  .object({
    preflightReady: z.literal(true),
    protocolNegotiated: z.literal(true),
    sessionCreated: z.literal(true),
    normalizedEvents: z.literal(true),
    terminalSucceeded: z.literal(true),
    artifactContract: z.literal(true),
    cancellationObserved: z.literal(true),
    cleanup: z.literal(true),
    noCliFallback: z.literal(true)
  })
  .strict();

const vpsPassedChecksSchema = z
  .object({
    certificateVerifiedTransport: z.literal(true),
    enrollmentOneTimeToken: z.literal(true),
    hostCapacityAdvertised: z.literal(true),
    hostCapabilitiesAdvertised: z.literal(true),
    envelopeDigestCaptured: z.literal(true),
    identitiesCaptured: z.literal(true),
    eventsCaptured: z.literal(true),
    heartbeatObserved: z.literal(true),
    runtimeResultAuthoritative: z.literal(true),
    networkInterruptReplay: z.literal(true),
    resourceBoundsConfirmed: z.literal(true),
    cleanupCompleted: z.literal(true),
    credentialsRevoked: z.literal(true)
  })
  .passthrough();

const vpsPassedIdentitiesSchema = z
  .object({
    operationId: z.string().min(1),
    dispatchId: z.string().min(1),
    executionAttemptId: z.string().min(1),
    hostId: z.string().min(1)
  })
  .passthrough();

function digestJson(value: unknown): string {
  const body = JSON.stringify(value);
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function countsAsPass(status: TierEvaluationStatus): boolean {
  return status === "passed";
}

/** Reject forged `result: "passed"` payloads that omit substantive proof fields. */
function rejectForgedPassed(
  tierId: ReleaseGateTierId,
  requirement: TierEvaluation["requirement"],
  raw: unknown,
  diagnostic: string,
  environmentClass: string | null
): TierEvaluation {
  return {
    tierId,
    requirement,
    status: "invalid",
    countsAsPass: false,
    evidenceDigest: digestJson(raw),
    diagnostic,
    observedAt: null,
    environmentClass
  };
}

function notProvided(tierId: ReleaseGateTierId): TierEvaluation {
  const tier = RELEASE_GATE_TIERS.find((item) => item.id === tierId)!;
  const liveExternalBlocker =
    tierId === "local_real_acp_compatibility" || tierId === "remote_authenticated_vps";
  return {
    tierId,
    requirement: tier.requirement,
    status: "not_provided",
    countsAsPass: false,
    evidenceDigest: null,
    diagnostic: liveExternalBlocker
      ? `external_blocker: no ${tier.evidenceVersion ?? tierId} evidence path. Live ACP/VPS infrastructure is operator-owned; mock or local fixtures must not be substituted as a pass.`
      : "No evidence path provided for this tier.",
    observedAt: null,
    environmentClass: null
  };
}

async function readJsonFile(path: string): Promise<{ value: unknown; mtimeIso: string }> {
  const [raw, fileStat] = await Promise.all([readFile(path, "utf8"), stat(path)]);
  try {
    return {
      value: JSON.parse(raw) as unknown,
      mtimeIso: fileStat.mtime.toISOString()
    };
  } catch {
    throw new Error(`release_gate_evidence_json_invalid:${path}`);
  }
}

function resolveObservedAt(explicit: string | null | undefined, mtimeIso: string): string {
  if (explicit && Number.isFinite(Date.parse(explicit))) return explicit;
  return mtimeIso;
}

export async function evaluateDeterministicEvidence(
  path: string | undefined
): Promise<TierEvaluation> {
  const tierId = "deterministic_process_suite" as const;
  if (!path) return notProvided(tierId);
  try {
    const { value: raw, mtimeIso } = await readJsonFile(path);
    const schema = z
      .object({
        version: z.literal("planweave.release-gate.deterministic/v1"),
        result: tierResultSchema,
        generatedAt: z.string().datetime().optional(),
        suite: z.string().min(1).max(256).optional(),
        exitCode: z.number().int().optional(),
        tests: z
          .object({
            total: z.number().int().nonnegative().optional(),
            passed: z.number().int().nonnegative().optional(),
            failed: z.number().int().nonnegative().optional()
          })
          .optional()
      })
      .passthrough();
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return {
        tierId,
        requirement: "required_ci",
        status: "invalid",
        countsAsPass: false,
        evidenceDigest: digestJson(raw),
        diagnostic: "Deterministic evidence schema mismatch.",
        observedAt: null,
        environmentClass: "ci"
      };
    }
    if (parsed.data.result === "passed") {
      const suiteOk = parsed.data.suite === "server-real-process";
      const exitOk = parsed.data.exitCode === 0 || parsed.data.exitCode === undefined;
      const failedOk =
        parsed.data.tests?.failed === undefined || parsed.data.tests.failed === 0;
      // Bare { result: "passed" } without suite identity is forgeable and invalid.
      if (!suiteOk || !exitOk || !failedOk) {
        return rejectForgedPassed(
          tierId,
          "required_ci",
          parsed.data,
          "Deterministic passed evidence requires suite=server-real-process and zero failed tests (forged result rejected).",
          "ci"
        );
      }
    }
    const status = parsed.data.result;
    return {
      tierId,
      requirement: "required_ci",
      status,
      countsAsPass: countsAsPass(status),
      evidenceDigest: digestJson(parsed.data),
      diagnostic: status === "passed" ? null : `Deterministic suite result=${status}`,
      observedAt: resolveObservedAt(parsed.data.generatedAt, mtimeIso),
      environmentClass: "ci"
    };
  } catch (error) {
    return {
      tierId,
      requirement: "required_ci",
      status: "invalid",
      countsAsPass: false,
      evidenceDigest: null,
      diagnostic: redactSensitiveText(
        error instanceof Error ? error.message : "deterministic_evidence_read_failed"
      ),
      observedAt: null,
      environmentClass: null
    };
  }
}

function isExpired(observedAt: string | null | undefined, now: Date): boolean {
  if (!observedAt) return true;
  const ts = Date.parse(observedAt);
  if (!Number.isFinite(ts)) return true;
  const maxMs = RELEASE_GATE_EVIDENCE_MAX_AGE_HOURS * 60 * 60 * 1000;
  return now.getTime() - ts > maxMs;
}

export async function evaluateRealAcpEvidence(
  path: string | undefined,
  now: Date
): Promise<TierEvaluation> {
  const tierId = "local_real_acp_compatibility" as const;
  if (!path) return notProvided(tierId);
  try {
    const { value: raw, mtimeIso } = await readJsonFile(path);
    const schema = z
      .object({
        version: z.literal("planweave.real-acp-host-smoke/v1"),
        result: tierResultSchema,
        preflight: z
          .object({
            profileId: z.string().min(1),
            protocolVersion: z.union([z.number(), z.string()]).optional(),
            agentVersion: z.string().nullable().optional()
          })
          .passthrough()
          .optional(),
        checks: z.record(z.string(), z.unknown()).optional(),
        generatedAt: z.string().datetime().optional()
      })
      .passthrough();
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return {
        tierId,
        requirement: "required_supported_version_release",
        status: "invalid",
        countsAsPass: false,
        evidenceDigest: digestJson(raw),
        diagnostic: "Real ACP evidence schema mismatch.",
        observedAt: null,
        environmentClass: "host-local"
      };
    }
    if (parsed.data.result === "passed") {
      const checksOk = realAcpPassedChecksSchema.safeParse(parsed.data.checks);
      const preflightOk =
        typeof parsed.data.preflight?.profileId === "string" &&
        parsed.data.preflight.profileId.length > 0 &&
        parsed.data.preflight.profileId !== "unresolved";
      if (!checksOk.success || !preflightOk) {
        return rejectForgedPassed(
          tierId,
          "required_supported_version_release",
          parsed.data,
          "Real ACP passed evidence requires all smoke checks true and a resolved preflight.profileId (forged result rejected).",
          "host-local"
        );
      }
    }
    const observedAt = resolveObservedAt(parsed.data.generatedAt, mtimeIso);
    if (parsed.data.result === "passed" && isExpired(observedAt, now)) {
      return {
        tierId,
        requirement: "required_supported_version_release",
        status: "expired",
        countsAsPass: false,
        evidenceDigest: digestJson(parsed.data),
        diagnostic: `Real ACP evidence expired (max age ${RELEASE_GATE_EVIDENCE_MAX_AGE_HOURS}h). Re-run with PLANWEAVE_REAL_ACP_REQUIRE=1.`,
        observedAt,
        environmentClass: "host-local"
      };
    }
    const status = parsed.data.result;
    // Skipped never counts as pass for supported-version release.
    return {
      tierId,
      requirement: "required_supported_version_release",
      status,
      countsAsPass: countsAsPass(status),
      evidenceDigest: digestJson(parsed.data),
      diagnostic:
        status === "skipped"
          ? "external_blocker: skipped live ACP smoke is not a pass for supported-version release. Real Host-local ACP agent + login required; mock ACP must not be substituted."
          : status === "passed"
            ? null
            : `Real ACP result=${status}`,
      observedAt,
      environmentClass: "host-local"
    };
  } catch (error) {
    return {
      tierId,
      requirement: "required_supported_version_release",
      status: "invalid",
      countsAsPass: false,
      evidenceDigest: null,
      diagnostic: redactSensitiveText(
        error instanceof Error ? error.message : "real_acp_evidence_read_failed"
      ),
      observedAt: null,
      environmentClass: null
    };
  }
}

export async function evaluateVpsEvidence(
  path: string | undefined,
  now: Date
): Promise<TierEvaluation> {
  const tierId = "remote_authenticated_vps" as const;
  if (!path) return notProvided(tierId);
  try {
    const { value: raw, mtimeIso } = await readJsonFile(path);
    const schema = z
      .object({
        version: z.literal("planweave.vps-authenticated-e2e/v1"),
        result: tierResultSchema,
        environmentClass: z.enum(["local-tls-fixture", "remote-vps", "unavailable"]),
        componentVersions: z
          .object({
            server: z.string().optional(),
            agentHost: z.string().nullable().optional(),
            protocol: z.number().nullable().optional()
          })
          .passthrough()
          .optional(),
        checks: z.record(z.string(), z.unknown()).optional(),
        identities: z.record(z.string(), z.unknown()).optional(),
        generatedAt: z.string().datetime().optional()
      })
      .passthrough();
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return {
        tierId,
        requirement: "required_pre_release_evidence",
        status: "invalid",
        countsAsPass: false,
        evidenceDigest: digestJson(raw),
        diagnostic: "VPS e2e evidence schema mismatch.",
        observedAt: null,
        environmentClass: null
      };
    }
    const observedAt = resolveObservedAt(parsed.data.generatedAt, mtimeIso);
    if (parsed.data.environmentClass !== "remote-vps") {
      return {
        tierId,
        requirement: "required_pre_release_evidence",
        status: parsed.data.result === "skipped" ? "skipped" : "invalid",
        countsAsPass: false,
        evidenceDigest: digestJson(parsed.data),
        diagnostic: `external_blocker: pre-release VPS evidence requires environmentClass=remote-vps (got ${parsed.data.environmentClass}). local-tls-fixture and mock fixtures are not a production VPS claim.`,
        observedAt,
        environmentClass: parsed.data.environmentClass
      };
    }
    if (parsed.data.result === "passed") {
      const checksOk = vpsPassedChecksSchema.safeParse(parsed.data.checks);
      const identitiesOk = vpsPassedIdentitiesSchema.safeParse(parsed.data.identities);
      if (!checksOk.success || !identitiesOk.success) {
        return rejectForgedPassed(
          tierId,
          "required_pre_release_evidence",
          parsed.data,
          "VPS passed evidence requires all remote checks true and non-null operation/dispatch/attempt/host identities (forged result rejected).",
          "remote-vps"
        );
      }
    }
    if (parsed.data.result === "passed" && isExpired(observedAt, now)) {
      return {
        tierId,
        requirement: "required_pre_release_evidence",
        status: "expired",
        countsAsPass: false,
        evidenceDigest: digestJson(parsed.data),
        diagnostic: `VPS evidence expired (max age ${RELEASE_GATE_EVIDENCE_MAX_AGE_HOURS}h). Re-run remote-vps with PLANWEAVE_VPS_E2E_REQUIRE=1.`,
        observedAt,
        environmentClass: "remote-vps"
      };
    }
    const status = parsed.data.result;
    return {
      tierId,
      requirement: "required_pre_release_evidence",
      status,
      countsAsPass: countsAsPass(status),
      evidenceDigest: digestJson(parsed.data),
      diagnostic:
        status === "skipped"
          ? "external_blocker: skipped VPS e2e is not a pass for pre-release evidence. Disposable remote VPS + outside-repo config required; local-tls-fixture must not be relabeled."
          : status === "passed"
            ? null
            : `VPS e2e result=${status}`,
      observedAt,
      environmentClass: "remote-vps"
    };
  } catch (error) {
    return {
      tierId,
      requirement: "required_pre_release_evidence",
      status: "invalid",
      countsAsPass: false,
      evidenceDigest: null,
      diagnostic: redactSensitiveText(
        error instanceof Error ? error.message : "vps_evidence_read_failed"
      ),
      observedAt: null,
      environmentClass: null
    };
  }
}

export type BuildReleaseGateReportInput = {
  deterministicEvidencePath?: string;
  realAcpEvidencePath?: string;
  vpsEvidencePath?: string;
  agentHostVersion?: string | null;
  protocolPackageVersion?: string | null;
  now?: Date;
};

export async function buildReleaseGateReport(
  input: BuildReleaseGateReportInput = {}
): Promise<ReleaseGateReport> {
  const now = input.now ?? new Date();
  const agentHostVersion = input.agentHostVersion ?? null;
  const protocolPackageVersion = input.protocolPackageVersion ?? null;

  const protocolCheck = assertAgentHostProtocolCompatible(
    PLANWEAVE_COMPATIBILITY_BOUNDS.agentHostProtocolVersion
  );
  const packageMajorCheck =
    agentHostVersion === null
      ? {
          ok: false as const,
          code: "agent_host_version_missing",
          message:
            "Agent Host package version not provided; cannot confirm major matrix for release."
        }
      : assertMatchingPackageMajors({
          server: serverPackageVersion,
          agentHost: agentHostVersion,
          protocol: protocolPackageVersion ?? undefined
        });

  const tiers = await Promise.all([
    evaluateDeterministicEvidence(input.deterministicEvidencePath),
    evaluateRealAcpEvidence(input.realAcpEvidencePath, now),
    evaluateVpsEvidence(input.vpsEvidencePath, now)
  ]);

  const byId = Object.fromEntries(tiers.map((tier) => [tier.tierId, tier])) as Record<
    ReleaseGateTierId,
    TierEvaluation
  >;

  const ciReady = byId.deterministic_process_suite.countsAsPass && protocolCheck.ok;
  const supportedReady =
    ciReady && byId.local_real_acp_compatibility.countsAsPass && packageMajorCheck.ok;
  const preReleaseReady = supportedReady && byId.remote_authenticated_vps.countsAsPass;

  const diagnostics = [
    !protocolCheck.ok ? protocolCheck.message : null,
    !packageMajorCheck.ok ? packageMajorCheck.message : null,
    ...tiers
      .filter((tier) => !tier.countsAsPass)
      .map((tier) => tier.diagnostic ?? `${tier.tierId}:${tier.status}`)
  ].filter((item): item is string => typeof item === "string" && item.length > 0);

  return {
    version: RELEASE_GATE_REPORT_VERSION,
    generatedAt: now.toISOString(),
    serverVersion: serverPackageVersion,
    compatibility: {
      bounds: PLANWEAVE_COMPATIBILITY_BOUNDS,
      protocolCheck: protocolCheck.ok
        ? { ok: true }
        : { ok: false, code: protocolCheck.code, message: protocolCheck.message },
      packageMajorCheck: packageMajorCheck.ok
        ? { ok: true }
        : {
            ok: false,
            code:
              "code" in packageMajorCheck ? packageMajorCheck.code : "package_major_check_failed",
            message:
              "message" in packageMajorCheck
                ? packageMajorCheck.message
                : "Package major check failed."
          },
      packageVersions: {
        server: packageVersionSchema.parse(serverPackageVersion),
        agentHost: agentHostVersion,
        protocol: protocolPackageVersion
      }
    },
    tiers,
    rollback: RELEASE_GATE_ROLLBACK_CHECKS.map((check) => ({
      ...check,
      status: "documented" as const,
      operatorMustConfirm: true as const
    })),
    rules: {
      skippedLiveIsNotPass: true,
      storeOnlySanitizedSummaries: true,
      neverEmbedSecrets: true,
      evidenceMaxAgeHours: RELEASE_GATE_EVIDENCE_MAX_AGE_HOURS
    },
    ownership: {
      liveInfrastructure:
        "Release operators own disposable VPS access, TLS material, enrollment tokens, and Host-local provider credentials. CI must not hold these secrets.",
      ci: "CI owns the deterministic multi-process suite only."
    },
    releaseReady: {
      ci: ciReady,
      supportedVersionRelease: supportedReady,
      preRelease: preReleaseReady
    },
    diagnostic: diagnostics.length > 0 ? diagnostics.join(" | ") : null
  };
}

export async function writeReleaseGateReport(
  path: string,
  report: ReleaseGateReport
): Promise<void> {
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
