import {
  emptyChecks,
  emptyIdentities,
  writeVpsE2eEvidence,
  type VpsE2eEvidence
} from "./evidence.js";
import { resolveVpsE2eTarget } from "./config.js";
import type { VpsE2eGate } from "./gate.js";
import { parseVpsE2eGate } from "./gate.js";
import { runLocalTlsFixture } from "./localTlsFixture.js";
import { runRemoteVpsScenario } from "./remoteVpsScenario.js";
import { serverPackageVersion } from "../packageInfo.js";

export type RunVpsE2eOptions = {
  gate?: VpsE2eGate;
  env?: Readonly<Record<string, string | undefined>>;
  evidencePath?: string;
};

function skippedEvidence(gate: VpsE2eGate, message: string, disposition: "skip" | "fail"): VpsE2eEvidence {
  return {
    version: "planweave.vps-authenticated-e2e/v1",
    environmentClass: "unavailable",
    gateMode: gate.mode,
    profileId: gate.profileId,
    componentVersions: {
      server: serverPackageVersion,
      agentHost: null,
      protocol: null,
      node: process.version
    },
    commandsSanitized: [],
    identities: emptyIdentities(),
    envelopeDigest: null,
    eventCursor: null,
    artifactHash: null,
    runtimeOutcome: null,
    interaction: { attempted: false, status: null },
    heartbeat: { hostLastSeenAtPresent: false },
    networkInterrupt: {
      performed: false,
      kind: null,
      replayOk: false,
      reconnectOk: false
    },
    resourceBounds: {
      maxArtifactBytes: null,
      maxWebSocketPayloadBytes: null,
      hostCapacity: null
    },
    checks: emptyChecks(),
    result: disposition === "skip" ? "skipped" : "failed",
    disposition,
    diagnostic: message,
    cleanup: { harnessStateRemoved: false, credentialsRevoked: false }
  };
}

/**
 * Opt-in authenticated VPS / local-TLS e2e entry.
 * Default CI never enables this path (gate disabled → skipped evidence if invoked).
 */
export async function runVpsAuthenticatedE2e(
  options: RunVpsE2eOptions = {}
): Promise<VpsE2eEvidence> {
  const env = options.env ?? process.env;
  const gate = options.gate ?? parseVpsE2eGate(env);

  if (!gate.enabled) {
    const evidence = skippedEvidence(
      gate,
      "VPS e2e gate is disabled. Set PLANWEAVE_VPS_E2E=1 (soft) or PLANWEAVE_VPS_E2E_REQUIRE=1 (hard).",
      "skip"
    );
    if (options.evidencePath) await writeVpsE2eEvidence(options.evidencePath, evidence);
    return evidence;
  }

  const target = await resolveVpsE2eTarget(gate, env);
  let evidence: VpsE2eEvidence;
  if (target.kind === "precondition") {
    evidence = skippedEvidence(
      gate,
      target.precondition.message,
      target.precondition.disposition
    );
  } else if (target.kind === "local-tls-fixture") {
    evidence = await runLocalTlsFixture({ gate, env });
  } else {
    evidence = await runRemoteVpsScenario({
      gate,
      config: target.config,
      operatorToken: target.operatorToken
    });
  }

  if (options.evidencePath) {
    await writeVpsE2eEvidence(options.evidencePath, evidence);
  }
  return evidence;
}
