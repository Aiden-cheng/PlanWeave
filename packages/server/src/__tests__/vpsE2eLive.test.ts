import { describe, expect, it } from "vitest";
import { parseVpsE2eGate, runVpsAuthenticatedE2e } from "../vpsE2e/index.js";

/**
 * Opt-in authenticated VPS / local-TLS e2e.
 *
 * Soft (default CI-safe when unset):
 *   PLANWEAVE_VPS_E2E=1 pnpm exec vitest run packages/server/src/__tests__/vpsE2eLive.test.ts
 *
 * Hard:
 *   PLANWEAVE_VPS_E2E_REQUIRE=1 pnpm exec vitest run packages/server/src/__tests__/vpsE2eLive.test.ts
 *
 * Profile:
 *   PLANWEAVE_VPS_E2E_PROFILE=local-tls-fixture|remote-vps
 *   PLANWEAVE_VPS_E2E_CONFIG=/absolute/outside-repo.json  (remote-vps only)
 *
 * Without a gate env var this file skips entirely so ordinary CI never starts Server/Host.
 */
const gate = parseVpsE2eGate();
const liveEnabled = gate.enabled;

describe.skipIf(!liveEnabled)("authenticated VPS / local-TLS e2e (opt-in)", () => {
  it("runs environmentClass scenario with redacted evidence contracts", async () => {
    const evidence = await runVpsAuthenticatedE2e({ gate });

    if (evidence.result === "skipped") {
      expect(gate.mode).toBe("soft");
      expect(evidence.disposition).toBe("skip");
      expect(evidence.diagnostic).toMatch(
        /openssl_missing|bins_missing|Built planweave-server|remote_config|remote_token|remote_unreachable|gate_disabled/i
      );
      return;
    }

    if (evidence.result === "failed" && evidence.disposition === "fail") {
      expect(gate.mode).toBe("require");
      expect(evidence.diagnostic).toBeTruthy();
      return;
    }

    expect(evidence.version).toBe("planweave.vps-authenticated-e2e/v1");
    expect(["local-tls-fixture", "remote-vps"]).toContain(evidence.environmentClass);
    // Never claim local loopback fixture is a production VPS.
    if (evidence.profileId === "local-tls-fixture") {
      expect(evidence.environmentClass).toBe("local-tls-fixture");
    }

    // Evidence must not embed raw secrets.
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toMatch(/pw_enroll_/);
    expect(serialized).not.toMatch(/BEGIN (CERTIFICATE|PRIVATE KEY)/);
    expect(serialized).not.toMatch(/Bearer [A-Za-z0-9]/);

    if (evidence.result === "passed") {
      expect(evidence.checks.certificateVerifiedTransport).toBe(true);
      expect(evidence.checks.identitiesCaptured).toBe(true);
      expect(evidence.checks.eventsCaptured).toBe(true);
      expect(evidence.checks.cleanupCompleted).toBe(true);
      if (evidence.environmentClass === "local-tls-fixture") {
        expect(evidence.checks.enrollmentOneTimeToken).toBe(true);
        expect(evidence.checks.envelopeDigestCaptured).toBe(true);
        expect(evidence.checks.artifactHashCaptured).toBe(true);
        expect(evidence.checks.networkInterruptReplay).toBe(true);
        expect(evidence.checks.credentialsRevoked).toBe(true);
        expect(evidence.envelopeDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      }
    }
  }, 180_000);
});
