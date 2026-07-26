import { writeFile } from "node:fs/promises";
import { z } from "zod";

const nullableIdentifierSchema = z.string().min(1).nullable();
const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const envelopeDigestSchema = z.string().regex(/^envelope:sha256:[a-f0-9]{64}$/);

export const vpsE2eEvidenceChecksSchema = z
  .object({
    certificateVerifiedTransport: z.boolean(),
    enrollmentOneTimeToken: z.boolean(),
    hostCapacityAdvertised: z.boolean(),
    hostCapabilitiesAdvertised: z.boolean(),
    envelopeDigestCaptured: z.boolean(),
    identitiesCaptured: z.boolean(),
    eventsCaptured: z.boolean(),
    heartbeatObserved: z.boolean(),
    artifactHashCaptured: z.boolean(),
    runtimeResultAuthoritative: z.boolean(),
    networkInterruptReplay: z.boolean(),
    resourceBoundsConfirmed: z.boolean(),
    cleanupCompleted: z.boolean(),
    credentialsRevoked: z.boolean()
  })
  .strict();

export const vpsE2eIdentityEvidenceSchema = z
  .object({
    operationId: nullableIdentifierSchema,
    dispatchId: nullableIdentifierSchema,
    executionAttemptId: nullableIdentifierSchema,
    leaseId: nullableIdentifierSchema,
    hostId: nullableIdentifierSchema,
    sessionId: nullableIdentifierSchema
  })
  .strict();

export const vpsE2eEvidenceSchema = z
  .object({
    version: z.literal("planweave.vps-authenticated-e2e/v1"),
    generatedAt: z.iso.datetime(),
    environmentClass: z.enum(["local-tls-fixture", "remote-vps", "unavailable"]),
    gateMode: z.enum(["disabled", "soft", "require"]),
    profileId: z.enum(["local-tls-fixture", "remote-vps"]),
    componentVersions: z
      .object({
        server: z.string().min(1),
        agentHost: z.string().min(1).nullable(),
        protocol: z.number().int().positive().nullable(),
        node: z.string().min(1)
      })
      .strict(),
    commandsSanitized: z.array(z.string()).max(128),
    identities: vpsE2eIdentityEvidenceSchema,
    envelopeDigest: envelopeDigestSchema.nullable(),
    eventCursor: z
      .object({
        afterCursor: z.number().int().nonnegative(),
        highWatermark: z.number().int().nonnegative(),
        eventCount: z.number().int().nonnegative()
      })
      .strict()
      .nullable(),
    artifactHash: sha256Schema.nullable(),
    runtimeOutcome: z.string().min(1).nullable(),
    interaction: z
      .object({ attempted: z.boolean(), status: z.string().min(1).nullable() })
      .strict(),
    heartbeat: z.object({ hostLastSeenAtPresent: z.boolean() }).strict(),
    networkInterrupt: z
      .object({
        performed: z.boolean(),
        kind: z.string().min(1).nullable(),
        replayOk: z.boolean(),
        reconnectOk: z.boolean()
      })
      .strict(),
    resourceBounds: z
      .object({
        maxArtifactBytes: z.number().int().positive().nullable(),
        maxWebSocketPayloadBytes: z.number().int().positive().nullable(),
        hostCapacity: z.number().int().positive().nullable()
      })
      .strict(),
    checks: vpsE2eEvidenceChecksSchema,
    result: z.enum(["passed", "failed", "skipped"]),
    disposition: z.enum(["skip", "fail"]).optional(),
    diagnostic: z.string().nullable(),
    cleanup: z
      .object({
        harnessStateRemoved: z.boolean(),
        credentialsRevoked: z.boolean(),
        diagnostics: z.array(z.string().min(1)).max(32)
      })
      .strict()
  })
  .strict()
  .superRefine((evidence, context) => {
    if (evidence.result !== "passed") return;
    const missingCheck = Object.entries(evidence.checks).find(([, value]) => value !== true)?.[0];
    if (missingCheck) {
      context.addIssue({
        code: "custom",
        message: `passed evidence requires checks.${missingCheck}=true`,
        path: ["checks", missingCheck]
      });
    }
    for (const key of [
      "operationId",
      "dispatchId",
      "executionAttemptId",
      "leaseId",
      "hostId"
    ] as const) {
      if (!evidence.identities[key]) {
        context.addIssue({
          code: "custom",
          message: `passed evidence requires identities.${key}`,
          path: ["identities", key]
        });
      }
    }
    if (!evidence.envelopeDigest) {
      context.addIssue({
        code: "custom",
        message: "passed evidence requires envelopeDigest",
        path: ["envelopeDigest"]
      });
    }
    if (!evidence.artifactHash) {
      context.addIssue({
        code: "custom",
        message: "passed evidence requires artifactHash",
        path: ["artifactHash"]
      });
    }
    if (
      !evidence.eventCursor ||
      evidence.eventCursor.eventCount < 1 ||
      evidence.eventCursor.highWatermark < evidence.eventCursor.afterCursor
    ) {
      context.addIssue({
        code: "custom",
        message: "passed evidence requires a consistent non-empty eventCursor",
        path: ["eventCursor"]
      });
    }
    if (evidence.runtimeOutcome !== "completed") {
      context.addIssue({
        code: "custom",
        message: "passed evidence requires runtimeOutcome=completed",
        path: ["runtimeOutcome"]
      });
    }
    if (!evidence.heartbeat.hostLastSeenAtPresent) {
      context.addIssue({
        code: "custom",
        message: "passed evidence requires heartbeat",
        path: ["heartbeat"]
      });
    }
    if (
      !evidence.networkInterrupt.performed ||
      !evidence.networkInterrupt.replayOk ||
      !evidence.networkInterrupt.reconnectOk
    ) {
      context.addIssue({
        code: "custom",
        message: "passed evidence requires successful network interrupt recovery",
        path: ["networkInterrupt"]
      });
    }
    if (
      !evidence.resourceBounds.maxArtifactBytes ||
      !evidence.resourceBounds.maxWebSocketPayloadBytes ||
      !evidence.resourceBounds.hostCapacity
    ) {
      context.addIssue({
        code: "custom",
        message: "passed evidence requires authoritative resource bounds",
        path: ["resourceBounds"]
      });
    }
    if (
      !evidence.cleanup.credentialsRevoked ||
      (evidence.environmentClass === "local-tls-fixture" && !evidence.cleanup.harnessStateRemoved)
    ) {
      context.addIssue({
        code: "custom",
        message: "passed evidence requires completed cleanup",
        path: ["cleanup"]
      });
    }
  });

export type VpsE2eEvidenceChecks = z.infer<typeof vpsE2eEvidenceChecksSchema>;
export type VpsE2eIdentityEvidence = z.infer<typeof vpsE2eIdentityEvidenceSchema>;
export type VpsE2eEvidence = z.infer<typeof vpsE2eEvidenceSchema>;
export type VpsE2eEnvironmentClass = VpsE2eEvidence["environmentClass"];

export function emptyChecks(): VpsE2eEvidenceChecks {
  return {
    certificateVerifiedTransport: false,
    enrollmentOneTimeToken: false,
    hostCapacityAdvertised: false,
    hostCapabilitiesAdvertised: false,
    envelopeDigestCaptured: false,
    identitiesCaptured: false,
    eventsCaptured: false,
    heartbeatObserved: false,
    artifactHashCaptured: false,
    runtimeResultAuthoritative: false,
    networkInterruptReplay: false,
    resourceBoundsConfirmed: false,
    cleanupCompleted: false,
    credentialsRevoked: false
  };
}

export function emptyIdentities(): VpsE2eIdentityEvidence {
  return {
    operationId: null,
    dispatchId: null,
    executionAttemptId: null,
    leaseId: null,
    hostId: null,
    sessionId: null
  };
}

export async function writeVpsE2eEvidence(path: string, evidence: VpsE2eEvidence): Promise<void> {
  const validated = vpsE2eEvidenceSchema.parse(evidence);
  await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
}
