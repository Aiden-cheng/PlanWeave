import { writeFile } from "node:fs/promises";
import type { VpsE2eGate } from "./gate.js";

/** Environment class labels — local-tls-fixture is not a production VPS claim. */
export type VpsE2eEnvironmentClass = "local-tls-fixture" | "remote-vps" | "unavailable";

export type VpsE2eEvidenceChecks = {
  certificateVerifiedTransport: boolean;
  enrollmentOneTimeToken: boolean;
  hostCapacityAdvertised: boolean;
  hostCapabilitiesAdvertised: boolean;
  envelopeDigestCaptured: boolean;
  identitiesCaptured: boolean;
  eventsCaptured: boolean;
  heartbeatObserved: boolean;
  artifactHashCaptured: boolean;
  runtimeResultAuthoritative: boolean;
  networkInterruptReplay: boolean;
  resourceBoundsConfirmed: boolean;
  cleanupCompleted: boolean;
  credentialsRevoked: boolean;
};

export type VpsE2eIdentityEvidence = {
  operationId: string | null;
  dispatchId: string | null;
  executionAttemptId: string | null;
  leaseId: string | null;
  hostId: string | null;
  sessionId: string | null;
};

export type VpsE2eEvidence = {
  version: "planweave.vps-authenticated-e2e/v1";
  environmentClass: VpsE2eEnvironmentClass;
  gateMode: VpsE2eGate["mode"];
  profileId: VpsE2eGate["profileId"];
  componentVersions: {
    server: string;
    agentHost: string | null;
    protocol: number | null;
    node: string;
  };
  commandsSanitized: string[];
  identities: VpsE2eIdentityEvidence;
  envelopeDigest: string | null;
  eventCursor: { afterCursor: number; highWatermark: number; eventCount: number } | null;
  artifactHash: string | null;
  runtimeOutcome: string | null;
  interaction: { attempted: boolean; status: string | null };
  heartbeat: { hostLastSeenAtPresent: boolean };
  networkInterrupt: {
    performed: boolean;
    kind: string | null;
    replayOk: boolean;
    reconnectOk: boolean;
  };
  resourceBounds: {
    maxArtifactBytes: number | null;
    maxWebSocketPayloadBytes: number | null;
    hostCapacity: number | null;
  };
  checks: VpsE2eEvidenceChecks;
  result: "passed" | "failed" | "skipped";
  disposition?: "skip" | "fail";
  diagnostic: string | null;
  cleanup: {
    harnessStateRemoved: boolean;
    credentialsRevoked: boolean;
  };
};

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
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}
