import { describe, expect, it } from "vitest";
import { parseRealAcpGate } from "../realAcp/gate.js";
import { runRealAcpSmoke } from "../realAcp/smoke.js";

/**
 * Opt-in real ACP integration.
 *
 * Soft gate (default CI-safe when unset):
 *   PLANWEAVE_REAL_ACP=1 pnpm exec vitest run packages/agent-host/src/__tests__/realAcpLiveSmoke.test.ts
 *
 * Hard gate (missing binary/login fails the suite):
 *   PLANWEAVE_REAL_ACP_REQUIRE=1 pnpm exec vitest run packages/agent-host/src/__tests__/realAcpLiveSmoke.test.ts
 *
 * Optional profile pin:
 *   PLANWEAVE_REAL_ACP_PROFILE=codex-acp
 *
 * Without a gate env var this file skips entirely so ordinary CI never starts a real Agent.
 */
const gate = parseRealAcpGate();
const liveEnabled = gate.enabled;

describe.skipIf(!liveEnabled)("real ACP Host-local live smoke", () => {
  it(
    "pref lights one Host-local profile, runs ACP-only execute + cancel, and records contract evidence",
    async () => {
      const evidence = await runRealAcpSmoke({ gate });

      // Soft gate may still skip when the machine lacks a binary/login; record disposition.
      if (evidence.result === "skipped") {
        expect(gate.mode).toBe("soft");
        expect(evidence.disposition).toBe("skip");
        expect(evidence.diagnostic).toMatch(
          /binary_missing|auth_required|credential_missing|preflight_failed|protocol_unsupported/
        );
        return;
      }

      if (evidence.result === "failed" && evidence.disposition === "fail") {
        // Hard gate precondition failure is an intentional fail (actionable).
        expect(gate.mode).toBe("require");
        expect(evidence.diagnostic).toBeTruthy();
        return;
      }

      expect(evidence.version).toBe("planweave.real-acp-host-smoke/v1");
      expect(evidence.checks.noCliFallback).toBe(true);
      expect(evidence.preflight.agentVersion === null || evidence.preflight.agentVersion.length > 0).toBe(
        true
      );
      expect(evidence.preflight.protocolVersion).toEqual(expect.anything());
      expect(evidence.result).toBe("passed");
      expect(evidence.checks.preflightReady).toBe(true);
      expect(evidence.checks.protocolNegotiated).toBe(true);
      expect(evidence.checks.sessionCreated).toBe(true);
      expect(evidence.checks.normalizedEvents).toBe(true);
      expect(evidence.checks.terminalSucceeded).toBe(true);
      expect(evidence.checks.artifactContract).toBe(true);
      expect(evidence.checks.cancellationObserved).toBe(true);
      expect(evidence.checks.cleanup).toBe(true);
      expect(evidence.stages.hostExecute?.sessionId).toEqual(expect.any(String));
      // Do not assert provider-specific reply text.
      expect(evidence.stages.hostExecute?.outputBytes).toBeGreaterThan(0);
    },
    300_000
  );
});
