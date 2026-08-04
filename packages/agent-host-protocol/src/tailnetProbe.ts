import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { canonicalizeJson } from "./canonicalJson.js";

export const TAILNET_PROBE_CHALLENGE_VERSION = "planweave.tailnet-probe-challenge/v1" as const;
export const TAILNET_PROBE_ARTIFACT_VERSION = "planweave.tailnet-probe-artifact/v1" as const;
export const TAILNET_PROBE_DIGEST_ALGORITHM = "sha256" as const;
export const TAILNET_PROBE_DIGEST_PREFIX = "sha256:" as const;
export const TAILNET_PROBE_MAX_TTL_MS = 24 * 60 * 60 * 1_000;
export const TAILNET_PROBE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
export const TAILNET_PROBE_CHALLENGE_HANDOFF_MAX_BYTES = 8_192;
export const TAILNET_PROBE_ARTIFACT_MAX_BYTES = 16_384;
export const TAILNET_PROBE_CHALLENGE_HANDOFF_PREFIX =
  `${TAILNET_PROBE_CHALLENGE_VERSION}.` as const;

const utf8Encoder = new TextEncoder();

export const tailnetProbeSha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export type TailnetProbeSha256Digest = z.infer<typeof tailnetProbeSha256DigestSchema>;

const nonceSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine(
    (nonce) => {
      const decoded = Buffer.from(nonce, "base64url");
      return decoded.byteLength === 32 && decoded.toString("base64url") === nonce;
    },
    {
      message: "nonce must be canonical base64url for exactly 256 bits"
    }
  );

export const tailnetProbeChallengeSchema = z
  .object({
    version: z.literal(TAILNET_PROBE_CHALLENGE_VERSION),
    nonce: nonceSchema,
    issuedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime()
  })
  .strict()
  .superRefine((challenge, context) => {
    const issuedAt = Date.parse(challenge.issuedAt);
    const expiresAt = Date.parse(challenge.expiresAt);
    if (expiresAt <= issuedAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "expiresAt must be after issuedAt"
      });
    } else if (expiresAt - issuedAt > TAILNET_PROBE_MAX_TTL_MS) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "challenge lifetime exceeds the maximum"
      });
    }
  });

export type TailnetProbeChallenge = z.infer<typeof tailnetProbeChallengeSchema>;

export function createTailnetProbeChallenge(
  options: { now?: Date; ttlMs?: number } = {}
): TailnetProbeChallenge {
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? TAILNET_PROBE_MAX_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > TAILNET_PROBE_MAX_TTL_MS) {
    throw new Error("tailnet_probe_challenge_ttl_invalid");
  }
  if (!Number.isFinite(now.getTime())) throw new Error("tailnet_probe_challenge_time_invalid");
  return tailnetProbeChallengeSchema.parse({
    version: TAILNET_PROBE_CHALLENGE_VERSION,
    nonce: randomBytes(32).toString("base64url"),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString()
  });
}

export function canonicalizeTailnetProbeChallenge(challenge: TailnetProbeChallenge): string {
  return canonicalizeJson(tailnetProbeChallengeSchema.parse(challenge));
}

export function hashTailnetProbeChallenge(
  challenge: TailnetProbeChallenge
): TailnetProbeSha256Digest {
  const digest = createHash(TAILNET_PROBE_DIGEST_ALGORITHM)
    .update(canonicalizeTailnetProbeChallenge(challenge), "utf8")
    .digest("hex");
  return tailnetProbeSha256DigestSchema.parse(`${TAILNET_PROBE_DIGEST_PREFIX}${digest}`);
}

export function encodeTailnetProbeChallengeHandoff(challenge: TailnetProbeChallenge): string {
  const payload = Buffer.from(canonicalizeTailnetProbeChallenge(challenge), "utf8").toString(
    "base64url"
  );
  return `${TAILNET_PROBE_CHALLENGE_HANDOFF_PREFIX}${payload}`;
}

export function parseTailnetProbeChallengeHandoff(
  handoff: string,
  now: Date = new Date()
): TailnetProbeChallenge {
  try {
    if (
      typeof handoff !== "string" ||
      utf8Encoder.encode(handoff).byteLength > TAILNET_PROBE_CHALLENGE_HANDOFF_MAX_BYTES ||
      !handoff.startsWith(TAILNET_PROBE_CHALLENGE_HANDOFF_PREFIX) ||
      !Number.isFinite(now.getTime())
    ) {
      throw new Error("invalid");
    }
    const encoded = handoff.slice(TAILNET_PROBE_CHALLENGE_HANDOFF_PREFIX.length);
    if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("invalid");
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    const challenge = tailnetProbeChallengeSchema.parse(JSON.parse(decoded));
    const nowMs = now.getTime();
    if (
      Date.parse(challenge.issuedAt) > nowMs + TAILNET_PROBE_CLOCK_SKEW_MS ||
      Date.parse(challenge.expiresAt) + TAILNET_PROBE_CLOCK_SKEW_MS < nowMs
    ) {
      throw new Error("invalid");
    }
    return challenge;
  } catch {
    throw new Error("tailnet_probe_challenge_handoff_invalid");
  }
}

export const tailnetProbeRoleSchema = z.enum([
  "windows-host",
  "linux-vps-host",
  "packaged-desktop-macos",
  "packaged-desktop-windows",
  "tailscale-acl-deny",
  "tailscale-serve-peer"
]);
export type TailnetProbeRole = z.infer<typeof tailnetProbeRoleSchema>;

const artifactCommonShape = {
  version: z.literal(TAILNET_PROBE_ARTIFACT_VERSION),
  generatedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  targetRunDigest: tailnetProbeSha256DigestSchema
} as const;

const windowsHostPassedSchema = z
  .object({
    ...artifactCommonShape,
    result: z.literal("passed"),
    role: z.literal("windows-host"),
    observations: z
      .object({
        platform: z.literal("windows"),
        serviceMode: z.literal("current-user-scheduled-task"),
        enrolledViaHandoff: z.literal(true),
        challengeDispatchObserved: z.literal(true),
        serviceRunning: z.literal(true),
        credentialActive: z.literal(true),
        tailnetHttpsConfigured: z.literal(true),
        explicitAgentExposed: z.literal(true),
        restartRecovered: z.literal(true)
      })
      .strict()
  })
  .strict();

const linuxVpsHostPassedSchema = z
  .object({
    ...artifactCommonShape,
    result: z.literal("passed"),
    role: z.literal("linux-vps-host"),
    observations: z
      .object({
        platform: z.literal("linux"),
        environment: z.literal("vps"),
        serviceMode: z.literal("systemd-user"),
        enrolledViaHandoff: z.literal(true),
        challengeDispatchObserved: z.literal(true),
        serviceRunning: z.literal(true),
        credentialActive: z.literal(true),
        tailnetHttpsConfigured: z.literal(true),
        explicitAgentExposed: z.literal(true),
        restartRecovered: z.literal(true)
      })
      .strict()
  })
  .strict();

function packagedDesktopPassedSchema(
  role: "packaged-desktop-macos" | "packaged-desktop-windows",
  platform: "macos" | "windows"
) {
  return z
    .object({
      ...artifactCommonShape,
      result: z.literal("passed"),
      role: z.literal(role),
      observations: z
        .object({
          platform: z.literal(platform),
          packagedApp: z.literal(true),
          tailnetConnected: z.literal(true),
          credentialPersistedAcrossRestart: z.literal(true),
          collaborationRecovered: z.literal(true)
        })
        .strict()
    })
    .strict();
}

const packagedDesktopMacosPassedSchema = packagedDesktopPassedSchema(
  "packaged-desktop-macos",
  "macos"
);
const packagedDesktopWindowsPassedSchema = packagedDesktopPassedSchema(
  "packaged-desktop-windows",
  "windows"
);

const tailscaleAclDenyPassedSchema = z
  .object({
    ...artifactCommonShape,
    result: z.literal("passed"),
    role: z.literal("tailscale-acl-deny"),
    observations: z
      .object({
        independentTailnetIdentity: z.literal(true),
        networkDenied: z.literal(true),
        planweaveResponseObserved: z.literal(false)
      })
      .strict()
  })
  .strict();

const tailscaleServePeerPassedSchema = z
  .object({
    ...artifactCommonShape,
    result: z.literal("passed"),
    role: z.literal("tailscale-serve-peer"),
    observations: z
      .object({
        independentTailnetPeer: z.literal(true),
        systemCaCertificate: z.literal(true),
        readyz: z.literal(true),
        websocketUpgrade: z.literal(true)
      })
      .strict()
  })
  .strict();

export const tailnetProbeFailureStageSchema = z.enum([
  "prerequisite",
  "service",
  "credential",
  "tailnet",
  "restart",
  "packaging",
  "collaboration",
  "network",
  "certificate",
  "readyz",
  "websocket"
]);
export const tailnetProbeFailureCodeSchema = z.enum([
  "not_available",
  "not_running",
  "inactive",
  "not_configured",
  "not_recovered",
  "unexpected_response",
  "denial_not_observed",
  "certificate_untrusted",
  "upgrade_failed"
]);
export const tailnetProbeSkippedReasonSchema = z.enum([
  "not_enabled",
  "prerequisite_unavailable",
  "operator_cancelled"
]);

const unsignedFailedArtifactSchema = z
  .object({
    ...artifactCommonShape,
    result: z.literal("failed"),
    role: tailnetProbeRoleSchema,
    failureStage: tailnetProbeFailureStageSchema,
    code: tailnetProbeFailureCodeSchema
  })
  .strict();

const unsignedSkippedArtifactSchema = z
  .object({
    ...artifactCommonShape,
    result: z.literal("skipped"),
    role: tailnetProbeRoleSchema,
    reason: tailnetProbeSkippedReasonSchema
  })
  .strict();

const unsignedPassedArtifactSchema = z.discriminatedUnion("role", [
  windowsHostPassedSchema,
  linuxVpsHostPassedSchema,
  packagedDesktopMacosPassedSchema,
  packagedDesktopWindowsPassedSchema,
  tailscaleAclDenyPassedSchema,
  tailscaleServePeerPassedSchema
]);

export const unsignedTailnetProbeArtifactSchema = z
  .discriminatedUnion("result", [
    unsignedPassedArtifactSchema,
    unsignedFailedArtifactSchema,
    unsignedSkippedArtifactSchema
  ])
  .superRefine((artifact, context) => {
    if (Date.parse(artifact.expiresAt) <= Date.parse(artifact.generatedAt)) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "expiresAt must be after generatedAt"
      });
    }
  });

export type UnsignedTailnetProbeArtifact = z.infer<typeof unsignedTailnetProbeArtifactSchema>;

function hashNormalizedTailnetProbeArtifact(artifact: unknown): TailnetProbeSha256Digest {
  const digest = createHash(TAILNET_PROBE_DIGEST_ALGORITHM)
    .update(canonicalizeJson(artifact), "utf8")
    .digest("hex");
  return tailnetProbeSha256DigestSchema.parse(`${TAILNET_PROBE_DIGEST_PREFIX}${digest}`);
}

export function computeTailnetProbeArtifactDigest(
  artifact: UnsignedTailnetProbeArtifact
): TailnetProbeSha256Digest {
  const normalized = unsignedTailnetProbeArtifactSchema.parse(artifact);
  return hashNormalizedTailnetProbeArtifact(normalized);
}

function withProbeDigest<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema
    .extend({ probeDigest: tailnetProbeSha256DigestSchema })
    .superRefine((artifact, context) => {
      const record = z.record(z.string(), z.unknown()).parse(artifact);
      const probeDigest = tailnetProbeSha256DigestSchema.parse(record.probeDigest);
      const unsignedArtifact = Object.fromEntries(
        Object.entries(record).filter(([key]) => key !== "probeDigest")
      );
      const timestamps = z
        .object({ generatedAt: z.string(), expiresAt: z.string() })
        .parse(artifact);
      if (Date.parse(timestamps.expiresAt) <= Date.parse(timestamps.generatedAt)) {
        context.addIssue({
          code: "custom",
          path: ["expiresAt"],
          message: "expiresAt must be after generatedAt"
        });
      }
      if (hashNormalizedTailnetProbeArtifact(unsignedArtifact) !== probeDigest) {
        context.addIssue({
          code: "custom",
          path: ["probeDigest"],
          message: "probeDigest does not match the canonical artifact"
        });
      }
    });
}

export const windowsHostTailnetProbeArtifactSchema = withProbeDigest(windowsHostPassedSchema);
export const linuxVpsHostTailnetProbeArtifactSchema = withProbeDigest(linuxVpsHostPassedSchema);
export const packagedDesktopMacosTailnetProbeArtifactSchema = withProbeDigest(
  packagedDesktopMacosPassedSchema
);
export const packagedDesktopWindowsTailnetProbeArtifactSchema = withProbeDigest(
  packagedDesktopWindowsPassedSchema
);
export const tailscaleAclDenyTailnetProbeArtifactSchema = withProbeDigest(
  tailscaleAclDenyPassedSchema
);
export const tailscaleServePeerTailnetProbeArtifactSchema = withProbeDigest(
  tailscaleServePeerPassedSchema
);

export const tailnetProbePassedArtifactSchema = z.discriminatedUnion("role", [
  windowsHostTailnetProbeArtifactSchema,
  linuxVpsHostTailnetProbeArtifactSchema,
  packagedDesktopMacosTailnetProbeArtifactSchema,
  packagedDesktopWindowsTailnetProbeArtifactSchema,
  tailscaleAclDenyTailnetProbeArtifactSchema,
  tailscaleServePeerTailnetProbeArtifactSchema
]);

export const tailnetProbeFailedArtifactSchema = withProbeDigest(unsignedFailedArtifactSchema);
export const tailnetProbeSkippedArtifactSchema = withProbeDigest(unsignedSkippedArtifactSchema);

export const tailnetProbeArtifactSchema = z
  .discriminatedUnion("result", [
    tailnetProbePassedArtifactSchema,
    tailnetProbeFailedArtifactSchema,
    tailnetProbeSkippedArtifactSchema
  ])
  .superRefine((artifact, context) => {
    if (
      utf8Encoder.encode(JSON.stringify(artifact)).byteLength > TAILNET_PROBE_ARTIFACT_MAX_BYTES
    ) {
      context.addIssue({
        code: "custom",
        message: "artifact exceeds the maximum size"
      });
    }
  });

export type TailnetProbeArtifact = z.infer<typeof tailnetProbeArtifactSchema>;

export function createTailnetProbeArtifact(
  artifact: UnsignedTailnetProbeArtifact
): TailnetProbeArtifact {
  const normalized = unsignedTailnetProbeArtifactSchema.parse(artifact);
  return tailnetProbeArtifactSchema.parse({
    ...normalized,
    probeDigest: computeTailnetProbeArtifactDigest(normalized)
  });
}

export function parseTailnetProbeArtifact(input: unknown): TailnetProbeArtifact {
  try {
    return tailnetProbeArtifactSchema.parse(input);
  } catch {
    throw new Error("tailnet_probe_artifact_invalid");
  }
}

export function validateTailnetProbeArtifactForChallenge(
  artifactInput: unknown,
  challengeInput: unknown,
  now: Date = new Date()
): TailnetProbeArtifact {
  try {
    const challenge = tailnetProbeChallengeSchema.parse(challengeInput);
    const artifact = tailnetProbeArtifactSchema.parse(artifactInput);
    const expectedRunDigest = hashTailnetProbeChallenge(challenge);
    const challengeStart = Date.parse(challenge.issuedAt);
    const challengeEnd = Date.parse(challenge.expiresAt);
    const generatedAt = Date.parse(artifact.generatedAt);
    const artifactEnd = Date.parse(artifact.expiresAt);
    const nowMs = now.getTime();
    if (
      !Number.isFinite(nowMs) ||
      artifact.targetRunDigest !== expectedRunDigest ||
      challengeStart > nowMs + TAILNET_PROBE_CLOCK_SKEW_MS ||
      challengeEnd + TAILNET_PROBE_CLOCK_SKEW_MS < nowMs ||
      generatedAt < challengeStart - TAILNET_PROBE_CLOCK_SKEW_MS ||
      generatedAt > challengeEnd ||
      generatedAt > nowMs + TAILNET_PROBE_CLOCK_SKEW_MS ||
      artifactEnd > challengeEnd ||
      artifactEnd + TAILNET_PROBE_CLOCK_SKEW_MS < nowMs
    ) {
      throw new Error("invalid");
    }
    return artifact;
  } catch {
    throw new Error("tailnet_probe_artifact_challenge_mismatch");
  }
}
