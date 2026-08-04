import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateTailnetEvidence } from "../releaseGate/evidence.js";
import { tailnetE2eEvidenceSchema } from "../tailnetE2e/evidence.js";

const roots: string[] = [];
const digest = (character: string) => `sha256:${character.repeat(64)}`;

function passedEvidence(generatedAt = "2030-01-01T00:00:00.000Z") {
  return {
    version: "planweave.tailnet-collaboration-e2e/v1",
    result: "passed",
    generatedAt,
    environmentClass: "tailnet-live",
    runDigest: digest("0"),
    transport: {
      httpsVerified: true,
      tailnetDnsVerified: true,
      loopbackBackendVerified: true
    },
    serve: {
      nodeOriginMatched: true,
      routeExact: true,
      ownedLease: true,
      funnelAbsent: true,
      readyProbePassed: true
    },
    desktops: {
      count: 2,
      identityDigests: [digest("1"), digest("2")],
      profileDigests: [digest("3"), digest("4")],
      vaultDigests: [digest("5"), digest("6")],
      checks: { identitiesDistinct: true, profilesDistinct: true, vaultsDistinct: true }
    },
    presence: {
      cursorObserved: true,
      selectionObserved: true,
      leaveObserved: true,
      rejoinObserved: true
    },
    collaboration: {
      liveSyncObserved: true,
      commandObserved: true,
      commentObserved: true,
      observerObserved: true,
      humanAndHostWebSocketsConcurrent: true
    },
    endpoint: {
      endpointDigest: digest("7"),
      checks: {
        explicitEndpointSelected: true,
        heartbeatObserved: true,
        v3DispatchObserved: true,
        completionObserved: true,
        eventObserved: true,
        artifactObserved: true
      }
    },
    platformMatrix: {
      windowsHost: {
        probeDigest: digest("8"),
        targetRunDigest: digest("0"),
        platform: "windows",
        serviceMode: "current-user-scheduled-task",
        remoteDeviceObserved: true,
        enrolledViaHandoff: true,
        explicitAgentExposure: true,
        endpointDispatch: true,
        restartRecovered: true
      },
      linuxVpsHost: {
        probeDigest: digest("9"),
        targetRunDigest: digest("0"),
        platform: "linux",
        environment: "vps",
        serviceMode: "systemd-user",
        remoteDeviceObserved: true,
        enrolledViaHandoff: true,
        explicitAgentExposure: true,
        endpointDispatch: true,
        restartRecovered: true
      },
      packagedDesktops: {
        macos: {
          probeDigest: digest("a"),
          targetRunDigest: digest("0"),
          platform: "macos",
          packagedDesktopConnected: true,
          restartRecovered: true
        },
        windows: {
          probeDigest: digest("b"),
          targetRunDigest: digest("0"),
          platform: "windows",
          packagedDesktopConnected: true,
          restartRecovered: true
        }
      }
    },
    externalProbes: {
      tailscaleAclDenied: {
        probeVersion: "planweave.tailnet-acl-denial-probe/v1",
        probeDigest: digest("c"),
        sourcePlatform: "linux",
        independentTailnetIdentity: true,
        targetRunDigest: digest("0"),
        networkDenied: true
      },
      tailscaleServe: {
        probeVersion: "planweave.tailscale-serve-probe/v1",
        probeDigest: digest("d"),
        targetRunDigest: digest("0"),
        tsNetCertificateVerified: true,
        serveRouteVerified: true,
        funnelAbsent: true,
        remotePeerConnected: true
      }
    },
    recovery: {
      reconnectCatchUpObserved: true,
      serveRestartRecovered: true,
      serverRestartRecovered: true,
      desktopRestartRecovered: true,
      hostRestartRecovered: true
    },
    authorization: { workspaceAclDenied: true },
    credentialLifecycle: { temporaryDesktopCredentialRevoked: true }
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function evidenceFile(value: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "planweave-tailnet-evidence-"));
  roots.push(root);
  const path = join(root, "evidence.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

describe("Tailnet collaboration evidence contract", () => {
  it("accepts complete sanitized live evidence", () => {
    const parsed = tailnetE2eEvidenceSchema.parse(passedEvidence());
    expect(parsed.result).toBe("passed");
    expect(parsed.environmentClass).toBe("tailnet-live");
  });

  it.each([
    {
      name: "missing substantive group",
      mutate: (value: Record<string, unknown>) => delete value.recovery
    },
    {
      name: "wrong environment class",
      mutate: (value: Record<string, unknown>) => (value.environmentClass = "remote-vps")
    },
    {
      name: "unknown sensitive field",
      mutate: (value: Record<string, unknown>) => (value.origin = "https://node.example.ts.net")
    },
    {
      name: "forged false passed check",
      mutate: (value: Record<string, unknown>) => {
        const transport = value.transport as Record<string, unknown>;
        transport.httpsVerified = false;
      }
    },
    {
      name: "non-digest identifier",
      mutate: (value: Record<string, unknown>) => {
        const endpoint = value.endpoint as Record<string, unknown>;
        endpoint.endpointDigest = "host-1";
      }
    },
    {
      name: "reused Desktop identity digest",
      mutate: (value: Record<string, unknown>) => {
        const desktops = value.desktops as Record<string, unknown>;
        desktops.identityDigests = [digest("1"), digest("1")];
      }
    },
    {
      name: "missing Windows Host attestation",
      mutate: (value: Record<string, unknown>) => {
        const matrix = value.platformMatrix as Record<string, unknown>;
        delete matrix.windowsHost;
      }
    },
    {
      name: "missing Linux VPS Host attestation",
      mutate: (value: Record<string, unknown>) => {
        const matrix = value.platformMatrix as Record<string, unknown>;
        delete matrix.linuxVpsHost;
      }
    },
    {
      name: "missing independent Tailscale ACL attestation",
      mutate: (value: Record<string, unknown>) => {
        const probes = value.externalProbes as Record<string, unknown>;
        delete probes.tailscaleAclDenied;
      }
    },
    {
      name: "reused platform probe digest",
      mutate: (value: Record<string, unknown>) => {
        const matrix = value.platformMatrix as Record<string, Record<string, unknown>>;
        matrix.linuxVpsHost!.probeDigest = matrix.windowsHost!.probeDigest;
      }
    },
    {
      name: "external probe run digest mismatch",
      mutate: (value: Record<string, unknown>) => {
        const probes = value.externalProbes as Record<string, Record<string, unknown>>;
        probes.tailscaleAclDenied!.targetRunDigest = digest("e");
      }
    },
    {
      name: "platform probe run digest mismatch",
      mutate: (value: Record<string, unknown>) => {
        const matrix = value.platformMatrix as Record<string, Record<string, unknown>>;
        matrix.windowsHost!.targetRunDigest = digest("e");
      }
    }
  ])("rejects $name", ({ mutate }) => {
    const value: Record<string, unknown> = structuredClone(passedEvidence());
    mutate(value);
    expect(tailnetE2eEvidenceSchema.safeParse(value).success).toBe(false);
  });

  it("rejects stale, future, and skipped evidence as release passes", async () => {
    const now = new Date("2030-01-15T00:00:00.000Z");
    const stalePath = await evidenceFile(passedEvidence("2029-12-01T00:00:00.000Z"));
    const futurePath = await evidenceFile(passedEvidence("2030-01-15T00:10:01.000Z"));
    const skippedPath = await evidenceFile({
      version: "planweave.tailnet-collaboration-e2e/v1",
      result: "skipped",
      generatedAt: now.toISOString(),
      environmentClass: "tailnet-live",
      reason: "external_probe_unavailable"
    });

    await expect(evaluateTailnetEvidence(stalePath, now)).resolves.toMatchObject({
      status: "expired",
      countsAsPass: false
    });
    await expect(evaluateTailnetEvidence(futurePath, now)).resolves.toMatchObject({
      status: "invalid",
      countsAsPass: false
    });
    await expect(evaluateTailnetEvidence(skippedPath, now)).resolves.toMatchObject({
      status: "skipped",
      countsAsPass: false
    });
  });

  it("accepts minimal failed evidence without treating it as a pass", async () => {
    const failed = {
      version: "planweave.tailnet-collaboration-e2e/v1",
      result: "failed",
      generatedAt: "2030-01-15T00:00:00.000Z",
      environmentClass: "tailnet-live",
      failureStage: "authorization"
    };
    expect(tailnetE2eEvidenceSchema.safeParse(failed).success).toBe(true);
    const path = await evidenceFile(failed);
    await expect(
      evaluateTailnetEvidence(path, new Date("2030-01-15T00:00:00.000Z"))
    ).resolves.toMatchObject({ status: "failed", countsAsPass: false });
  });

  it("does not expose an evidence path or file contents in invalid diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-tailnet-secret-"));
    roots.push(root);
    const path = join(root, "do-not-leak-token.json");
    await writeFile(path, "not-json secret-value");

    const evaluation = await evaluateTailnetEvidence(path, new Date());
    expect(evaluation.status).toBe("invalid");
    expect(evaluation.diagnostic).toBe("tailnet_evidence_read_failed");
    expect(JSON.stringify(evaluation)).not.toContain(path);
    expect(JSON.stringify(evaluation)).not.toContain("secret-value");
  });
});
