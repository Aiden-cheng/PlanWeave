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
    await writeFile(
      deterministicPath,
      JSON.stringify({
        version: "planweave.release-gate.deterministic/v1",
        result: "passed",
        generatedAt: new Date().toISOString(),
        suite: "server-real-process"
      })
    );
    await writeFile(
      localVpsPath,
      JSON.stringify({
        version: "planweave.vps-authenticated-e2e/v1",
        result: "passed",
        environmentClass: "local-tls-fixture",
        generatedAt: new Date().toISOString()
      })
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
    await writeFile(
      deterministicPath,
      JSON.stringify({
        version: "planweave.release-gate.deterministic/v1",
        result: "passed",
        generatedAt: new Date().toISOString(),
        suite: "server-real-process"
      })
    );
    await writeFile(
      realAcpPath,
      JSON.stringify({
        version: "planweave.real-acp-host-smoke/v1",
        result: "skipped",
        preflight: { profileId: "codex-acp", protocolVersion: 1, agentVersion: null }
      })
    );
    await writeFile(
      vpsPath,
      JSON.stringify({
        version: "planweave.vps-authenticated-e2e/v1",
        result: "skipped",
        environmentClass: "unavailable"
      })
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
      JSON.stringify({
        version: "planweave.vps-authenticated-e2e/v1",
        result: "passed",
        environmentClass: "local-tls-fixture",
        generatedAt: new Date().toISOString()
      })
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
        preflight: { profileId: "codex-acp", protocolVersion: 1, agentVersion: "1.0.0" }
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
        suite: "server-real-process"
      })
    );
    await writeFile(
      realAcpPath,
      JSON.stringify({
        version: "planweave.real-acp-host-smoke/v1",
        result: "passed",
        generatedAt: now,
        preflight: { profileId: "codex-acp", protocolVersion: 1, agentVersion: "0.1.0" }
      })
    );
    await writeFile(
      vpsPath,
      JSON.stringify({
        version: "planweave.vps-authenticated-e2e/v1",
        result: "passed",
        environmentClass: "remote-vps",
        generatedAt: now,
        componentVersions: { server: "0.3.0", agentHost: "0.3.0", protocol: 1 }
      })
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
    await writeFile(
      deterministicPath,
      JSON.stringify({
        version: "planweave.release-gate.deterministic/v1",
        result: "passed",
        generatedAt: new Date().toISOString(),
        suite: "server-real-process"
      })
    );
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
