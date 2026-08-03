import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  PLANWEAVE_COMPATIBILITY_BOUNDS,
  assertAgentHostProtocolCompatible,
  assertMatchingPackageMajors,
  packageVersionSchema
} from "@planweave-ai/agent-host-protocol";
import { serverPackageVersion } from "../packageInfo.js";
import {
  RELEASE_GATE_EVIDENCE_MAX_AGE_HOURS,
  RELEASE_GATE_EVIDENCE_MAX_CLOCK_SKEW_MS,
  RELEASE_GATE_ROLLBACK_CHECKS,
  RELEASE_GATE_TIERS,
  type ReleaseGateTierId,
  type RollbackCheckDefinition
} from "./checklist.js";
import { redactSensitiveText } from "../vpsE2e/redaction.js";
import { vpsE2eEvidenceSchema } from "../vpsE2e/evidence.js";

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

async function readJsonFile(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`release_gate_evidence_json_invalid:${path}`);
  }
}

/**
 * TTL uses only evidence.generatedAt written by the producer.
 * File mtime is intentionally ignored so `touch` cannot freshen evidence.
 */
function resolveObservedAt(generatedAt: string | undefined): string | null {
  if (!generatedAt || !Number.isFinite(Date.parse(generatedAt))) return null;
  return generatedAt;
}

export async function evaluateDeterministicEvidence(
  path: string | undefined
): Promise<TierEvaluation> {
  const tierId = "deterministic_process_suite" as const;
  if (!path) return notProvided(tierId);
  try {
    const raw = await readJsonFile(path);
    const schema = z
      .object({
        version: z.literal("planweave.release-gate.deterministic/v1"),
        result: tierResultSchema,
        generatedAt: z.string().datetime(),
        suite: z.string().min(1).max(256).optional(),
        exitCode: z.number().int().optional(),
        tests: z
          .object({
            total: z.number().int().nonnegative(),
            passed: z.number().int().nonnegative(),
            failed: z.number().int().nonnegative()
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
        diagnostic:
          "Deterministic evidence schema mismatch (generatedAt required; mtime is not used).",
        observedAt: null,
        environmentClass: "ci"
      };
    }
    if (parsed.data.result === "passed") {
      const suiteOk = parsed.data.suite === "server-real-process";
      const exitOk = parsed.data.exitCode === 0;
      const testsOk =
        parsed.data.tests !== undefined &&
        parsed.data.tests.total > 0 &&
        parsed.data.tests.failed === 0 &&
        parsed.data.tests.passed === parsed.data.tests.total;
      if (!suiteOk || !exitOk || !testsOk) {
        return rejectForgedPassed(
          tierId,
          "required_ci",
          parsed.data,
          "Deterministic passed evidence requires suite=server-real-process, exitCode=0, and a complete passing test count (forged result rejected).",
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
      observedAt: resolveObservedAt(parsed.data.generatedAt),
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

function evidenceFreshness(
  observedAt: string | null | undefined,
  now: Date
): "fresh" | "expired" | "future" | "invalid" {
  if (!observedAt) return "invalid";
  const ts = Date.parse(observedAt);
  if (!Number.isFinite(ts)) return "invalid";
  if (ts - now.getTime() > RELEASE_GATE_EVIDENCE_MAX_CLOCK_SKEW_MS) return "future";
  const maxMs = RELEASE_GATE_EVIDENCE_MAX_AGE_HOURS * 60 * 60 * 1000;
  return now.getTime() - ts > maxMs ? "expired" : "fresh";
}

export async function evaluateRealAcpEvidence(
  path: string | undefined,
  now: Date
): Promise<TierEvaluation> {
  const tierId = "local_real_acp_compatibility" as const;
  if (!path) return notProvided(tierId);
  try {
    const raw = await readJsonFile(path);
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
        generatedAt: z.string().datetime()
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
        diagnostic: "Real ACP evidence schema mismatch (generatedAt required; mtime is not used).",
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
    const observedAt = resolveObservedAt(parsed.data.generatedAt);
    const freshness = evidenceFreshness(observedAt, now);
    if (parsed.data.result === "passed" && freshness === "future") {
      return {
        tierId,
        requirement: "required_supported_version_release",
        status: "invalid",
        countsAsPass: false,
        evidenceDigest: digestJson(parsed.data),
        diagnostic: "Real ACP evidence generatedAt exceeds the allowed clock skew.",
        observedAt,
        environmentClass: "host-local"
      };
    }
    if (parsed.data.result === "passed" && freshness === "expired") {
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
    const raw = await readJsonFile(path);
    const parsed = vpsE2eEvidenceSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        tierId,
        requirement: "required_pre_release_evidence",
        status: "invalid",
        countsAsPass: false,
        evidenceDigest: digestJson(raw),
        diagnostic:
          "VPS e2e evidence schema mismatch: complete strict producer evidence is required (forged result rejected; generatedAt required and mtime is not used).",
        observedAt: null,
        environmentClass: null
      };
    }
    const observedAt = resolveObservedAt(parsed.data.generatedAt);
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
    const freshness = evidenceFreshness(observedAt, now);
    if (parsed.data.result === "passed" && freshness === "future") {
      return {
        tierId,
        requirement: "required_pre_release_evidence",
        status: "invalid",
        countsAsPass: false,
        evidenceDigest: digestJson(parsed.data),
        diagnostic: "VPS evidence generatedAt exceeds the allowed clock skew.",
        observedAt,
        environmentClass: "remote-vps"
      };
    }
    if (parsed.data.result === "passed" && freshness === "expired") {
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
