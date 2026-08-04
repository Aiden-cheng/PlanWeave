import {
  linuxVpsHostTailnetProbeArtifactSchema,
  packagedDesktopMacosTailnetProbeArtifactSchema,
  packagedDesktopWindowsTailnetProbeArtifactSchema,
  tailscaleAclDenyTailnetProbeArtifactSchema,
  tailscaleServePeerTailnetProbeArtifactSchema,
  tailnetProbeSha256DigestSchema,
  windowsHostTailnetProbeArtifactSchema
} from "@planweave-ai/agent-host-protocol/tailnet-e2e";
import { z } from "zod";

export const TAILNET_E2E_EVIDENCE_VERSION = "planweave.tailnet-collaboration-e2e/v1" as const;

const sha256DigestSchema = tailnetProbeSha256DigestSchema;
const passedCheckSchema = z.literal(true);

function checkGroup<T extends readonly [string, ...string[]]>(keys: T, check: z.ZodType<boolean>) {
  return z.object(Object.fromEntries(keys.map((key) => [key, check]))).strict();
}

const transportKeys = ["httpsVerified", "tailnetDnsVerified", "loopbackBackendVerified"] as const;
const serveKeys = [
  "nodeOriginMatched",
  "routeExact",
  "ownedLease",
  "funnelAbsent",
  "readyProbePassed"
] as const;
const desktopKeys = ["identitiesDistinct", "profilesDistinct", "vaultsDistinct"] as const;
const presenceKeys = [
  "cursorObserved",
  "selectionObserved",
  "leaveObserved",
  "rejoinObserved"
] as const;
const collaborationKeys = [
  "liveSyncObserved",
  "commandObserved",
  "commentObserved",
  "observerObserved",
  "humanAndHostWebSocketsConcurrent"
] as const;
const endpointKeys = [
  "explicitEndpointSelected",
  "heartbeatObserved",
  "v3DispatchObserved",
  "completionObserved",
  "eventObserved",
  "artifactObserved"
] as const;
const recoveryKeys = [
  "reconnectCatchUpObserved",
  "serveRestartRecovered",
  "serverRestartRecovered",
  "desktopRestartRecovered",
  "hostRestartRecovered"
] as const;
const authorizationKeys = ["workspaceAclDenied"] as const;
const credentialKeys = ["temporaryDesktopCredentialRevoked"] as const;

const passedEvidenceShape = {
  generatedAt: z.iso.datetime(),
  environmentClass: z.literal("tailnet-live"),
  runDigest: sha256DigestSchema,
  transport: checkGroup(transportKeys, passedCheckSchema),
  serve: checkGroup(serveKeys, passedCheckSchema),
  desktops: z
    .object({
      count: z.literal(2),
      identityDigests: z.tuple([sha256DigestSchema, sha256DigestSchema]),
      profileDigests: z.tuple([sha256DigestSchema, sha256DigestSchema]),
      vaultDigests: z.tuple([sha256DigestSchema, sha256DigestSchema]),
      checks: checkGroup(desktopKeys, passedCheckSchema)
    })
    .strict(),
  presence: checkGroup(presenceKeys, passedCheckSchema),
  collaboration: checkGroup(collaborationKeys, passedCheckSchema),
  endpoint: z
    .object({
      endpointDigest: sha256DigestSchema,
      checks: checkGroup(endpointKeys, passedCheckSchema)
    })
    .strict(),
  platformMatrix: z
    .object({
      windowsHost: windowsHostTailnetProbeArtifactSchema,
      linuxVpsHost: linuxVpsHostTailnetProbeArtifactSchema,
      packagedDesktops: z
        .object({
          macos: packagedDesktopMacosTailnetProbeArtifactSchema,
          windows: packagedDesktopWindowsTailnetProbeArtifactSchema
        })
        .strict()
    })
    .strict(),
  externalProbes: z
    .object({
      tailscaleAclDenied: tailscaleAclDenyTailnetProbeArtifactSchema,
      tailscaleServe: tailscaleServePeerTailnetProbeArtifactSchema
    })
    .strict(),
  recovery: checkGroup(recoveryKeys, passedCheckSchema),
  authorization: checkGroup(authorizationKeys, passedCheckSchema),
  credentialLifecycle: checkGroup(credentialKeys, passedCheckSchema)
};

const passedEvidenceSchema = z
  .object({
    version: z.literal(TAILNET_E2E_EVIDENCE_VERSION),
    result: z.literal("passed"),
    ...passedEvidenceShape
  })
  .strict();

const skippedEvidenceSchema = z
  .object({
    version: z.literal(TAILNET_E2E_EVIDENCE_VERSION),
    result: z.literal("skipped"),
    generatedAt: z.iso.datetime(),
    environmentClass: z.literal("tailnet-live"),
    reason: z.enum(["not_enabled", "prerequisite_unavailable", "external_probe_unavailable"])
  })
  .strict();

const failedEvidenceSchema = z
  .object({
    version: z.literal(TAILNET_E2E_EVIDENCE_VERSION),
    result: z.literal("failed"),
    generatedAt: z.iso.datetime(),
    environmentClass: z.literal("tailnet-live"),
    failureStage: z.enum([
      "config",
      "tailscale",
      "serve",
      "desktop",
      "collaboration",
      "authorization",
      "agent_host",
      "recovery",
      "credential_cleanup"
    ]),
    runDigest: sha256DigestSchema.optional()
  })
  .strict();

/**
 * This strict operator evidence prevents accidental omissions and unsafe detail
 * capture. It does not authenticate evidence against a malicious operator.
 */
export const tailnetE2eEvidenceSchema = z
  .discriminatedUnion("result", [passedEvidenceSchema, skippedEvidenceSchema, failedEvidenceSchema])
  .superRefine((evidence, context) => {
    if (evidence.result !== "passed") return;
    for (const [field, digests] of [
      ["identityDigests", evidence.desktops.identityDigests],
      ["profileDigests", evidence.desktops.profileDigests],
      ["vaultDigests", evidence.desktops.vaultDigests]
    ] as const) {
      if (new Set(digests).size !== digests.length) {
        context.addIssue({
          code: "custom",
          message: `desktop ${field} must identify two distinct values`,
          path: ["desktops", field]
        });
      }
    }

    const probeDigests = [
      evidence.platformMatrix.windowsHost.probeDigest,
      evidence.platformMatrix.linuxVpsHost.probeDigest,
      evidence.platformMatrix.packagedDesktops.macos.probeDigest,
      evidence.platformMatrix.packagedDesktops.windows.probeDigest,
      evidence.externalProbes.tailscaleAclDenied.probeDigest,
      evidence.externalProbes.tailscaleServe.probeDigest
    ];
    if (new Set(probeDigests).size !== probeDigests.length) {
      context.addIssue({
        code: "custom",
        message: "platform and external probe digests must be unique",
        path: ["platformMatrix"]
      });
    }

    for (const [path, targetRunDigest] of [
      [["platformMatrix", "windowsHost"], evidence.platformMatrix.windowsHost.targetRunDigest],
      [["platformMatrix", "linuxVpsHost"], evidence.platformMatrix.linuxVpsHost.targetRunDigest],
      [
        ["platformMatrix", "packagedDesktops", "macos"],
        evidence.platformMatrix.packagedDesktops.macos.targetRunDigest
      ],
      [
        ["platformMatrix", "packagedDesktops", "windows"],
        evidence.platformMatrix.packagedDesktops.windows.targetRunDigest
      ],
      [
        ["externalProbes", "tailscaleAclDenied"],
        evidence.externalProbes.tailscaleAclDenied.targetRunDigest
      ],
      [["externalProbes", "tailscaleServe"], evidence.externalProbes.tailscaleServe.targetRunDigest]
    ] as const) {
      if (targetRunDigest !== evidence.runDigest) {
        context.addIssue({
          code: "custom",
          message: `${path.join(".")}.targetRunDigest must match runDigest`,
          path: [...path, "targetRunDigest"]
        });
      }
    }
  });

export type TailnetE2eEvidence = z.infer<typeof tailnetE2eEvidenceSchema>;
