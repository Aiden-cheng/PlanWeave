import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import {
  RELEASE_GATE_TIERS,
  buildReleaseGateReport,
  runReleaseGateCli
} from "../releaseGate/index.js";

const roots: string[] = [];

function deterministicPassed(generatedAt = new Date().toISOString()) {
  return {
    version: "planweave.release-gate.deterministic/v1",
    result: "passed",
    generatedAt,
    suite: "server-real-process",
    exitCode: 0,
    tests: { total: 10, passed: 10, failed: 0 }
  };
}

function vpsEvidence(input: {
  result: "passed" | "failed" | "skipped";
  environmentClass: "local-tls-fixture" | "remote-vps" | "unavailable";
  generatedAt?: string;
}) {
  const passed = input.result === "passed";
  return {
    version: "planweave.vps-authenticated-e2e/v1",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    environmentClass: input.environmentClass,
    gateMode: "require",
    profileId: input.environmentClass === "local-tls-fixture" ? "local-tls-fixture" : "remote-vps",
    componentVersions: { server: "0.3.0", agentHost: "0.3.0", protocol: 1, node: "v24" },
    commandsSanitized: [],
    identities: {
      operationId: passed ? "op-1" : null,
      dispatchId: passed ? "dispatch-1" : null,
      executionAttemptId: passed ? "attempt-1" : null,
      leaseId: passed ? "lease-1" : null,
      hostId: passed ? "host-1" : null,
      sessionId: null
    },
    envelopeDigest: passed ? `envelope:sha256:${"a".repeat(64)}` : null,
    eventCursor: passed ? { afterCursor: 0, highWatermark: 4, eventCount: 4 } : null,
    artifactHash: passed ? `sha256:${"b".repeat(64)}` : null,
    runtimeOutcome: passed ? "completed" : null,
    interaction: { attempted: false, status: null },
    heartbeat: { hostLastSeenAtPresent: passed },
    networkInterrupt: {
      performed: passed,
      kind: passed ? "packaged_host_restart" : null,
      replayOk: passed,
      reconnectOk: passed
    },
    resourceBounds: {
      maxArtifactBytes: passed ? 1024 : null,
      maxWebSocketPayloadBytes: passed ? 2048 : null,
      hostCapacity: passed ? 1 : null
    },
    checks: {
      certificateVerifiedTransport: passed,
      enrollmentOneTimeToken: passed,
      hostCapacityAdvertised: passed,
      hostCapabilitiesAdvertised: passed,
      envelopeDigestCaptured: passed,
      identitiesCaptured: passed,
      eventsCaptured: passed,
      heartbeatObserved: passed,
      artifactHashCaptured: passed,
      runtimeResultAuthoritative: passed,
      networkInterruptReplay: passed,
      resourceBoundsConfirmed: passed,
      cleanupCompleted: passed,
      credentialsRevoked: passed
    },
    result: input.result,
    diagnostic: passed ? null : "external_blocker",
    cleanup: {
      harnessStateRemoved: passed && input.environmentClass === "local-tls-fixture",
      credentialsRevoked: passed
    }
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "planweave-release-gate-"));
  roots.push(root);
  return root;
}

describe("release gate checklist and evaluation", () => {
  it("defines three distinct tiers with separate requirements", () => {
    expect(RELEASE_GATE_TIERS.map((tier) => tier.id)).toEqual([
      "deterministic_process_suite",
      "local_real_acp_compatibility",
      "remote_authenticated_vps"
    ]);
    expect(RELEASE_GATE_TIERS.map((tier) => tier.requirement)).toEqual([
      "required_ci",
      "required_supported_version_release",
      "required_pre_release_evidence"
    ]);
  });

  it("treats missing evidence as not_provided and never release-ready", async () => {
    const report = await buildReleaseGateReport({
      agentHostVersion: "0.3.0",
      protocolPackageVersion: "0.3.0"
    });
    expect(report.rules.skippedLiveIsNotPass).toBe(true);
    expect(report.releaseReady).toEqual({
      ci: false,
      supportedVersionRelease: false,
      preRelease: false
    });
    expect(report.tiers.every((tier) => tier.status === "not_provided")).toBe(true);
    expect(report.tiers.every((tier) => tier.countsAsPass === false)).toBe(true);
    expect(report.rollback.every((item) => item.operatorMustConfirm)).toBe(true);
    expect(report.compatibility.bounds.rollbackConstraints.resetDatabases).toBe(false);
  });

  it("keeps live ACP/VPS as external blockers when evidence is missing or local-only", async () => {
    const root = await tempDir();
    const deterministicPath = join(root, "det.json");
    const localVpsPath = join(root, "local-vps.json");
    await writeFile(deterministicPath, JSON.stringify(deterministicPassed()));
    await writeFile(
      localVpsPath,
      JSON.stringify(vpsEvidence({ result: "passed", environmentClass: "local-tls-fixture" }))
    );

    const missingLive = await buildReleaseGateReport({
      deterministicEvidencePath: deterministicPath,
      agentHostVersion: "0.3.0",
      protocolPackageVersion: "0.3.0"
    });
    expect(missingLive.releaseReady.ci).toBe(true);
    expect(missingLive.releaseReady.supportedVersionRelease).toBe(false);
    expect(missingLive.releaseReady.preRelease).toBe(false);
    expect(
      missingLive.tiers.find((tier) => tier.tierId === "local_real_acp_compatibility")
    ).toMatchObject({
      status: "not_provided",
      countsAsPass: false,
      diagnostic: expect.stringMatching(/external_blocker/)
    });
    expect(
      missingLive.tiers.find((tier) => tier.tierId === "remote_authenticated_vps")
    ).toMatchObject({
      status: "not_provided",
      countsAsPass: false,
      diagnostic: expect.stringMatching(/external_blocker/)
    });

    const localFixture = await buildReleaseGateReport({
      deterministicEvidencePath: deterministicPath,
      vpsEvidencePath: localVpsPath,
      agentHostVersion: "0.3.0",
      protocolPackageVersion: "0.3.0"
    });
    expect(localFixture.releaseReady.preRelease).toBe(false);
    expect(
      localFixture.tiers.find((tier) => tier.tierId === "remote_authenticated_vps")
    ).toMatchObject({
      countsAsPass: false,
      diagnostic: expect.stringMatching(/external_blocker|remote-vps|local-tls-fixture/)
    });
  });

  it("does not treat skipped live evidence as a pass", async () => {
    const root = await tempDir();
    const deterministicPath = join(root, "det.json");
    const realAcpPath = join(root, "acp.json");
    const vpsPath = join(root, "vps.json");
    await writeFile(deterministicPath, JSON.stringify(deterministicPassed()));
    await writeFile(
      realAcpPath,
      JSON.stringify({
        version: "planweave.real-acp-host-smoke/v1",
        result: "skipped",
        generatedAt: new Date().toISOString(),
        preflight: { profileId: "codex-acp", protocolVersion: 1, agentVersion: null }
      })
    );
    await writeFile(
      vpsPath,
      JSON.stringify(vpsEvidence({ result: "skipped", environmentClass: "unavailable" }))
    );

    const report = await buildReleaseGateReport({
      deterministicEvidencePath: deterministicPath,
      realAcpEvidencePath: realAcpPath,
      vpsEvidencePath: vpsPath,
      agentHostVersion: "0.3.0",
      protocolPackageVersion: "0.3.0"
    });

    expect(report.releaseReady.ci).toBe(true);
    expect(report.releaseReady.supportedVersionRelease).toBe(false);
    expect(report.releaseReady.preRelease).toBe(false);
    expect(report.tiers.find((t) => t.tierId === "local_real_acp_compatibility")).toMatchObject({
      status: "skipped",
      countsAsPass: false
    });
    expect(report.tiers.find((t) => t.tierId === "remote_authenticated_vps")).toMatchObject({
      countsAsPass: false
    });
  });

  it("rejects local-tls-fixture as pre-release VPS evidence", async () => {
    const root = await tempDir();
    const vpsPath = join(root, "vps.json");
    await writeFile(
      vpsPath,
      JSON.stringify(vpsEvidence({ result: "passed", environmentClass: "local-tls-fixture" }))
    );
    const report = await buildReleaseGateReport({
      vpsEvidencePath: vpsPath,
      agentHostVersion: "0.3.0",
      protocolPackageVersion: "0.3.0"
    });
    const vps = report.tiers.find((t) => t.tierId === "remote_authenticated_vps");
    expect(vps?.countsAsPass).toBe(false);
    expect(vps?.diagnostic).toMatch(/remote-vps/);
  });

  it("marks expired live evidence as not a pass", async () => {
    const root = await tempDir();
    const realAcpPath = join(root, "acp.json");
    const old = new Date(Date.now() - 400 * 60 * 60 * 1000).toISOString();
    await writeFile(
      realAcpPath,
      JSON.stringify({
        version: "planweave.real-acp-host-smoke/v1",
        result: "passed",
        generatedAt: old,
        preflight: { profileId: "codex-acp", protocolVersion: 1, agentVersion: "1.0.0" },
        checks: {
          preflightReady: true,
          protocolNegotiated: true,
          sessionCreated: true,
          normalizedEvents: true,
          terminalSucceeded: true,
          artifactContract: true,
          cancellationObserved: true,
          cleanup: true,
          noCliFallback: true
        }
      })
    );
    const report = await buildReleaseGateReport({
      realAcpEvidencePath: realAcpPath,
      agentHostVersion: "0.3.0",
      protocolPackageVersion: "0.3.0",
      now: new Date()
    });
    expect(report.tiers.find((t) => t.tierId === "local_real_acp_compatibility")).toMatchObject({
      status: "expired",
      countsAsPass: false
    });
  });

  it("rejects live evidence without generatedAt and ignores file mtime for TTL", async () => {
    const root = await tempDir();
    const missingGeneratedAt = join(root, "no-generated-at.json");
    const oldGeneratedAt = join(root, "old-generated-at.json");
    await writeFile(
      missingGeneratedAt,
      JSON.stringify({
        version: "planweave.real-acp-host-smoke/v1",
        result: "passed",
        preflight: { profileId: "codex-acp", protocolVersion: 1, agentVersion: "1.0.0" },
        checks: {
          preflightReady: true,
          protocolNegotiated: true,
          sessionCreated: true,
          normalizedEvents: true,
          terminalSucceeded: true,
          artifactContract: true,
          cancellationObserved: true,
          cleanup: true,
          noCliFallback: true
        }
      })
    );
    const old = new Date(Date.now() - 400 * 60 * 60 * 1000).toISOString();
    await writeFile(
      oldGeneratedAt,
      JSON.stringify({
        version: "planweave.real-acp-host-smoke/v1",
        result: "passed",
        generatedAt: old,
        preflight: { profileId: "codex-acp", protocolVersion: 1, agentVersion: "1.0.0" },
        checks: {
          preflightReady: true,
          protocolNegotiated: true,
          sessionCreated: true,
          normalizedEvents: true,
          terminalSucceeded: true,
          artifactContract: true,
          cancellationObserved: true,
          cleanup: true,
          noCliFallback: true
        }
      })
    );
    // Freshen file mtime without changing generatedAt — must still expire.
    const { utimes } = await import("node:fs/promises");
    const now = new Date();
    await utimes(oldGeneratedAt, now, now);

    const missing = await buildReleaseGateReport({
      realAcpEvidencePath: missingGeneratedAt,
      agentHostVersion: "0.3.0",
      protocolPackageVersion: "0.3.0"
    });
    expect(missing.tiers.find((t) => t.tierId === "local_real_acp_compatibility")).toMatchObject({
      status: "invalid",
      countsAsPass: false,
      diagnostic: expect.stringMatching(/generatedAt required|mtime is not used/)
    });

    const stale = await buildReleaseGateReport({
      realAcpEvidencePath: oldGeneratedAt,
      agentHostVersion: "0.3.0",
      protocolPackageVersion: "0.3.0",
      now: new Date()
    });
    expect(stale.tiers.find((t) => t.tierId === "local_real_acp_compatibility")).toMatchObject({
      status: "expired",
      countsAsPass: false,
      observedAt: old
    });
  });

  it("rejects forged passed evidence without substantive checks", async () => {
    const root = await tempDir();
    const now = new Date().toISOString();
    const forgedDet = join(root, "forged-det.json");
    const forgedAcp = join(root, "forged-acp.json");
    const forgedVps = join(root, "forged-vps.json");
    await writeFile(
      forgedDet,
      JSON.stringify({
        version: "planweave.release-gate.deterministic/v1",
        result: "passed",
        generatedAt: now
      })
    );
    await writeFile(
      forgedAcp,
      JSON.stringify({
        version: "planweave.real-acp-host-smoke/v1",
        result: "passed",
        generatedAt: now,
        preflight: { profileId: "codex-acp" }
      })
    );
    await writeFile(
      forgedVps,
      JSON.stringify({
        version: "planweave.vps-authenticated-e2e/v1",
        result: "passed",
        environmentClass: "remote-vps",
        generatedAt: now
      })
    );

    const report = await buildReleaseGateReport({
      deterministicEvidencePath: forgedDet,
      realAcpEvidencePath: forgedAcp,
      vpsEvidencePath: forgedVps,
      agentHostVersion: "0.3.0",
      protocolPackageVersion: "0.3.0"
    });
    expect(report.releaseReady).toEqual({
      ci: false,
      supportedVersionRelease: false,
      preRelease: false
    });
    for (const tier of report.tiers) {
      expect(tier.countsAsPass).toBe(false);
      expect(tier.status).toBe("invalid");
      expect(tier.diagnostic).toMatch(/forged result rejected|requires/);
    }
  });

  it("rejects self-reported VPS pass when producer evidence contradicts checks", async () => {
    const root = await tempDir();
    const runtimeMismatchPath = join(root, "runtime-mismatch.json");
    const unknownFieldPath = join(root, "unknown-field.json");
    await writeFile(
      runtimeMismatchPath,
      JSON.stringify({
        ...vpsEvidence({ result: "passed", environmentClass: "remote-vps" }),
        runtimeOutcome: "failed"
      })
    );
    await writeFile(
      unknownFieldPath,
      JSON.stringify({
        ...vpsEvidence({ result: "passed", environmentClass: "remote-vps" }),
        selfReportedPass: true
      })
    );

    for (const vpsEvidencePath of [runtimeMismatchPath, unknownFieldPath]) {
      const report = await buildReleaseGateReport({
        vpsEvidencePath,
        agentHostVersion: "0.3.0",
        protocolPackageVersion: "0.3.0"
      });
      expect(report.tiers.find((tier) => tier.tierId === "remote_authenticated_vps")).toMatchObject(
        { status: "invalid", countsAsPass: false }
      );
    }
  });

  it("becomes pre-release ready only when all three tiers pass and majors match", async () => {
    const root = await tempDir();
    const now = new Date().toISOString();
    const deterministicPath = join(root, "det.json");
    const realAcpPath = join(root, "acp.json");
    const vpsPath = join(root, "vps.json");
    await writeFile(
      deterministicPath,
      JSON.stringify({
        version: "planweave.release-gate.deterministic/v1",
        result: "passed",
        generatedAt: now,
        suite: "server-real-process",
        exitCode: 0,
        tests: { total: 10, passed: 10, failed: 0 }
      })
    );
    await writeFile(
      realAcpPath,
      JSON.stringify({
        version: "planweave.real-acp-host-smoke/v1",
        result: "passed",
        generatedAt: now,
        preflight: { profileId: "codex-acp", protocolVersion: 1, agentVersion: "0.1.0" },
        checks: {
          preflightReady: true,
          protocolNegotiated: true,
          sessionCreated: true,
          normalizedEvents: true,
          terminalSucceeded: true,
          artifactContract: true,
          cancellationObserved: true,
          cleanup: true,
          noCliFallback: true
        }
      })
    );
    await writeFile(
      vpsPath,
      JSON.stringify(
        vpsEvidence({ result: "passed", environmentClass: "remote-vps", generatedAt: now })
      )
    );

    const report = await buildReleaseGateReport({
      deterministicEvidencePath: deterministicPath,
      realAcpEvidencePath: realAcpPath,
      vpsEvidencePath: vpsPath,
      agentHostVersion: "0.3.0",
      protocolPackageVersion: "0.3.0"
    });
    expect(report.releaseReady).toEqual({
      ci: true,
      supportedVersionRelease: true,
      preRelease: true
    });
    expect(report.diagnostic).toBeNull();
  });

  it("fails package major matrix for mismatched Server/Host versions", async () => {
    const report = await buildReleaseGateReport({
      agentHostVersion: "1.0.0",
      protocolPackageVersion: "0.3.0"
    });
    expect(report.compatibility.packageMajorCheck.ok).toBe(false);
    expect(report.releaseReady.supportedVersionRelease).toBe(false);
  });

  it("CLI checklist mode and usage errors", async () => {
    const lines: string[] = [];
    const code = await runReleaseGateCli(["--checklist"], {
      io: {
        stdout: (value) => lines.push(value),
        stderr: () => {}
      }
    });
    expect(code).toBe(0);
    const body = JSON.parse(lines.join("")) as { tiers: unknown[] };
    expect(body.tiers).toHaveLength(3);

    const usage = await runReleaseGateCli(["--unknown"], {
      io: { stdout: () => {}, stderr: () => {} }
    });
    expect(usage).toBe(2);
  });

  it("CLI evaluates evidence and exits non-zero when live tiers are missing", async () => {
    const root = await tempDir();
    const deterministicPath = join(root, "det.json");
    await writeFile(deterministicPath, JSON.stringify(deterministicPassed()));
    const code = await runReleaseGateCli(
      [
        "--deterministic-evidence",
        deterministicPath,
        "--agent-host-version",
        "0.3.0",
        "--protocol-version",
        "0.3.0"
      ],
      { io: { stdout: () => {}, stderr: () => {} } }
    );
    expect(code).toBe(1);
  });
});
