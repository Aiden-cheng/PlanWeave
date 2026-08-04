import { describe, expect, it } from "vitest";
import {
  TAILNET_PROBE_ARTIFACT_VERSION,
  TAILNET_PROBE_ARTIFACT_MAX_BYTES,
  TAILNET_PROBE_CHALLENGE_HANDOFF_MAX_BYTES,
  TAILNET_PROBE_CHALLENGE_VERSION,
  TAILNET_PROBE_CLOCK_SKEW_MS,
  TAILNET_PROBE_MAX_TTL_MS,
  computeTailnetProbeArtifactDigest,
  createTailnetProbeArtifact,
  createTailnetProbeChallenge,
  encodeTailnetProbeChallengeHandoff,
  hashTailnetProbeChallenge,
  parseTailnetProbeArtifact,
  parseTailnetProbeChallengeHandoff,
  tailnetProbeArtifactSchema,
  tailnetProbeChallengeSchema,
  tailnetProbePassedArtifactSchema,
  unsignedTailnetProbeArtifactSchema,
  validateTailnetProbeArtifactForChallenge,
  type TailnetProbeChallenge,
  type UnsignedTailnetProbeArtifact
} from "../tailnetProbe.js";

const issuedAt = new Date("2030-01-01T00:00:00.000Z");
const verificationTime = new Date("2030-01-01T00:05:00.000Z");
const nonce = (byte: number) => Buffer.alloc(32, byte).toString("base64url");

function challenge(): TailnetProbeChallenge {
  return tailnetProbeChallengeSchema.parse({
    version: TAILNET_PROBE_CHALLENGE_VERSION,
    nonce: nonce(1),
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 60 * 60 * 1_000).toISOString()
  });
}

function common(target = hashTailnetProbeChallenge(challenge())) {
  return {
    version: TAILNET_PROBE_ARTIFACT_VERSION,
    result: "passed" as const,
    generatedAt: "2030-01-01T00:04:00.000Z",
    expiresAt: "2030-01-01T00:30:00.000Z",
    targetRunDigest: target
  };
}

const passedArtifacts = [
  {
    ...common(),
    role: "windows-host" as const,
    observations: {
      platform: "windows" as const,
      serviceMode: "current-user-scheduled-task" as const,
      enrolledViaHandoff: true as const,
      challengeDispatchObserved: true as const,
      serviceRunning: true as const,
      credentialActive: true as const,
      tailnetHttpsConfigured: true as const,
      explicitAgentExposed: true as const,
      restartRecovered: true as const
    }
  },
  {
    ...common(),
    role: "linux-vps-host" as const,
    observations: {
      platform: "linux" as const,
      environment: "vps" as const,
      serviceMode: "systemd-user" as const,
      enrolledViaHandoff: true as const,
      challengeDispatchObserved: true as const,
      serviceRunning: true as const,
      credentialActive: true as const,
      tailnetHttpsConfigured: true as const,
      explicitAgentExposed: true as const,
      restartRecovered: true as const
    }
  },
  {
    ...common(),
    role: "packaged-desktop-macos" as const,
    observations: {
      platform: "macos" as const,
      packagedApp: true as const,
      tailnetConnected: true as const,
      credentialPersistedAcrossRestart: true as const,
      collaborationRecovered: true as const
    }
  },
  {
    ...common(),
    role: "packaged-desktop-windows" as const,
    observations: {
      platform: "windows" as const,
      packagedApp: true as const,
      tailnetConnected: true as const,
      credentialPersistedAcrossRestart: true as const,
      collaborationRecovered: true as const
    }
  },
  {
    ...common(),
    role: "tailscale-acl-deny" as const,
    observations: {
      independentTailnetIdentity: true as const,
      networkDenied: true as const,
      planweaveResponseObserved: false as const
    }
  },
  {
    ...common(),
    role: "tailscale-serve-peer" as const,
    observations: {
      independentTailnetPeer: true as const,
      systemCaCertificate: true as const,
      readyz: true as const,
      websocketUpgrade: true as const
    }
  }
] satisfies UnsignedTailnetProbeArtifact[];

function rewriteHandoff(
  source: TailnetProbeChallenge,
  mutate: (value: Record<string, unknown>) => void
): string {
  const value = structuredClone(source) as Record<string, unknown>;
  mutate(value);
  const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${TAILNET_PROBE_CHALLENGE_VERSION}.${encoded}`;
}

describe("Tailnet probe challenge contract", () => {
  it("generates a 256-bit nonce and round-trips an opaque handoff", () => {
    const created = createTailnetProbeChallenge({ now: issuedAt, ttlMs: 60_000 });
    expect(Buffer.from(created.nonce, "base64url")).toHaveLength(32);
    const handoff = encodeTailnetProbeChallengeHandoff(created);
    expect(handoff).not.toContain(created.nonce);
    expect(parseTailnetProbeChallengeHandoff(handoff, issuedAt)).toEqual(created);
    expect(hashTailnetProbeChallenge(created)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it.each([
    {
      name: "tampered shape",
      handoff: () => rewriteHandoff(challenge(), (value) => (value.nonce = "b".repeat(42))),
      now: verificationTime
    },
    {
      name: "44-character nonce",
      handoff: () => rewriteHandoff(challenge(), (value) => (value.nonce = `${nonce(1)}A`)),
      now: verificationTime
    },
    {
      name: "33-byte nonce",
      handoff: () =>
        rewriteHandoff(challenge(), (value) => {
          value.nonce = Buffer.alloc(33, 2).toString("base64url");
        }),
      now: verificationTime
    },
    {
      name: "noncanonical nonce",
      handoff: () =>
        rewriteHandoff(challenge(), (value) => {
          value.nonce = `${nonce(1).slice(0, -1)}F`;
        }),
      now: verificationTime
    },
    {
      name: "expired challenge",
      handoff: () => encodeTailnetProbeChallengeHandoff(challenge()),
      now: new Date(issuedAt.getTime() + 60 * 60 * 1_000 + TAILNET_PROBE_CLOCK_SKEW_MS + 1)
    },
    {
      name: "future challenge",
      handoff: () => encodeTailnetProbeChallengeHandoff(challenge()),
      now: new Date(issuedAt.getTime() - TAILNET_PROBE_CLOCK_SKEW_MS - 1)
    },
    {
      name: "overlong lifetime",
      handoff: () =>
        rewriteHandoff(challenge(), (value) => {
          value.expiresAt = new Date(
            issuedAt.getTime() + TAILNET_PROBE_MAX_TTL_MS + 1
          ).toISOString();
        }),
      now: verificationTime
    },
    {
      name: "reversed expiry",
      handoff: () =>
        rewriteHandoff(challenge(), (value) => {
          value.expiresAt = "2029-12-31T23:59:59.999Z";
        }),
      now: verificationTime
    },
    {
      name: "wrong payload version",
      handoff: () =>
        rewriteHandoff(challenge(), (value) => {
          value.version = "planweave.tailnet-probe-challenge/v2";
        }),
      now: verificationTime
    },
    {
      name: "wrong prefix",
      handoff: () => encodeTailnetProbeChallengeHandoff(challenge()).replace(/^planweave/, "other"),
      now: verificationTime
    },
    {
      name: "oversized handoff",
      handoff: () => "x".repeat(TAILNET_PROBE_CHALLENGE_HANDOFF_MAX_BYTES + 1),
      now: verificationTime
    }
  ])("rejects $name without echoing the handoff", ({ handoff, now }) => {
    const secretHandoff = handoff();
    let thrown: unknown;
    try {
      parseTailnetProbeChallengeHandoff(secretHandoff, now);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("tailnet_probe_challenge_handoff_invalid");
    expect((thrown as Error).message).not.toContain(secretHandoff);
  });

  it("rejects invalid generator TTLs", () => {
    expect(() =>
      createTailnetProbeChallenge({ now: issuedAt, ttlMs: TAILNET_PROBE_MAX_TTL_MS + 1 })
    ).toThrow("tailnet_probe_challenge_ttl_invalid");
  });

  it("allows a challenge timestamp within the fixed clock skew", () => {
    const handoff = encodeTailnetProbeChallengeHandoff(challenge());
    const now = new Date(issuedAt.getTime() - TAILNET_PROBE_CLOCK_SKEW_MS);
    expect(parseTailnetProbeChallengeHandoff(handoff, now)).toEqual(challenge());
  });
});

describe("Tailnet probe artifact contract", () => {
  it.each(passedArtifacts)("accepts a canonical $role passed artifact", (unsigned) => {
    const artifact = createTailnetProbeArtifact(unsigned);
    expect(parseTailnetProbeArtifact(artifact)).toEqual(artifact);
    expect(artifact.probeDigest).toBe(computeTailnetProbeArtifactDigest(unsigned));
    expect(
      validateTailnetProbeArtifactForChallenge(artifact, challenge(), verificationTime)
    ).toEqual(artifact);
  });

  it("accepts a minimal failed artifact without passed observations", () => {
    const artifact = createTailnetProbeArtifact({
      version: TAILNET_PROBE_ARTIFACT_VERSION,
      result: "failed",
      role: "windows-host",
      generatedAt: "2030-01-01T00:04:00.000Z",
      expiresAt: "2030-01-01T00:30:00.000Z",
      targetRunDigest: hashTailnetProbeChallenge(challenge()),
      failureStage: "service",
      code: "not_running"
    });
    expect(artifact.result).toBe("failed");
    expect("observations" in artifact).toBe(false);
  });

  it("accepts a canonical minimal skipped artifact with its own digest", () => {
    const unsigned = {
      version: TAILNET_PROBE_ARTIFACT_VERSION,
      result: "skipped" as const,
      role: "linux-vps-host" as const,
      generatedAt: "2030-01-01T00:04:00.000Z",
      expiresAt: "2030-01-01T00:30:00.000Z",
      targetRunDigest: hashTailnetProbeChallenge(challenge()),
      reason: "prerequisite_unavailable" as const
    };
    const artifact = createTailnetProbeArtifact(unsigned);
    expect(artifact.probeDigest).toBe(computeTailnetProbeArtifactDigest(unsigned));
    expect(parseTailnetProbeArtifact(artifact)).toEqual(artifact);
    expect(tailnetProbePassedArtifactSchema.safeParse(artifact).success).toBe(false);
    expect(tailnetProbeArtifactSchema.safeParse({ ...artifact, rawError: "secret" }).success).toBe(
      false
    );
  });

  it.each([
    {
      name: "unknown sensitive field",
      mutate: (value: Record<string, unknown>) => (value.token = "secret")
    },
    {
      name: "wrong platform for role",
      mutate: (value: Record<string, unknown>) => {
        (value.observations as Record<string, unknown>).platform = "linux";
      }
    },
    {
      name: "false passed observation",
      mutate: (value: Record<string, unknown>) => {
        (value.observations as Record<string, unknown>).serviceRunning = false;
      }
    },
    {
      name: "missing passed observation",
      mutate: (value: Record<string, unknown>) => {
        delete (value.observations as Record<string, unknown>).credentialActive;
      }
    },
    {
      name: "probe digest mismatch",
      mutate: (value: Record<string, unknown>) => (value.probeDigest = `sha256:${"f".repeat(64)}`)
    }
  ])("rejects $name", ({ mutate }) => {
    const value = structuredClone(createTailnetProbeArtifact(passedArtifacts[0]!)) as Record<
      string,
      unknown
    >;
    mutate(value);
    expect(tailnetProbeArtifactSchema.safeParse(value).success).toBe(false);
  });

  it("rejects target run mismatch and cross-run replay", () => {
    const artifact = createTailnetProbeArtifact(passedArtifacts[0]!);
    const otherChallenge = tailnetProbeChallengeSchema.parse({
      ...challenge(),
      nonce: nonce(2)
    });
    expect(() =>
      validateTailnetProbeArtifactForChallenge(artifact, otherChallenge, verificationTime)
    ).toThrow("tailnet_probe_artifact_challenge_mismatch");
  });

  it.each([
    {
      name: "before challenge window",
      generatedAt: new Date(issuedAt.getTime() - TAILNET_PROBE_CLOCK_SKEW_MS - 1).toISOString(),
      expiresAt: "2030-01-01T00:30:00.000Z",
      now: verificationTime
    },
    {
      name: "beyond challenge TTL",
      generatedAt: "2030-01-01T00:04:00.000Z",
      expiresAt: "2030-01-01T01:00:00.001Z",
      now: verificationTime
    },
    {
      name: "expired at verification",
      generatedAt: "2030-01-01T00:04:00.000Z",
      expiresAt: "2030-01-01T00:30:00.000Z",
      now: new Date("2030-01-01T00:35:00.001Z")
    },
    {
      name: "generated in the future",
      generatedAt: new Date(
        verificationTime.getTime() + TAILNET_PROBE_CLOCK_SKEW_MS + 1
      ).toISOString(),
      expiresAt: "2030-01-01T00:30:00.000Z",
      now: verificationTime
    }
  ])("rejects artifact $name", ({ generatedAt, expiresAt, now }) => {
    const artifact = createTailnetProbeArtifact({
      ...passedArtifacts[0]!,
      generatedAt,
      expiresAt
    });
    expect(() => validateTailnetProbeArtifactForChallenge(artifact, challenge(), now)).toThrow(
      "tailnet_probe_artifact_challenge_mismatch"
    );
  });

  it("allows artifact timestamps at the fixed clock-skew boundary", () => {
    const artifact = createTailnetProbeArtifact({
      ...passedArtifacts[0]!,
      generatedAt: new Date(issuedAt.getTime() - TAILNET_PROBE_CLOCK_SKEW_MS).toISOString()
    });
    expect(
      validateTailnetProbeArtifactForChallenge(artifact, challenge(), verificationTime)
    ).toEqual(artifact);
  });

  it("rejects a challenge issued beyond clock skew even when artifact time is otherwise valid", () => {
    const futureIssuedAt = new Date(
      verificationTime.getTime() + TAILNET_PROBE_CLOCK_SKEW_MS + 60_000
    );
    const futureChallenge = tailnetProbeChallengeSchema.parse({
      version: TAILNET_PROBE_CHALLENGE_VERSION,
      nonce: nonce(3),
      issuedAt: futureIssuedAt.toISOString(),
      expiresAt: new Date(futureIssuedAt.getTime() + 60 * 60 * 1_000).toISOString()
    });
    const artifact = createTailnetProbeArtifact({
      ...passedArtifacts[0]!,
      generatedAt: new Date(futureIssuedAt.getTime() - TAILNET_PROBE_CLOCK_SKEW_MS).toISOString(),
      expiresAt: new Date(futureIssuedAt.getTime() + 30 * 60 * 1_000).toISOString(),
      targetRunDigest: hashTailnetProbeChallenge(futureChallenge)
    });
    expect(() =>
      validateTailnetProbeArtifactForChallenge(artifact, futureChallenge, verificationTime)
    ).toThrow("tailnet_probe_artifact_challenge_mismatch");
  });

  it("accepts a challenge issued exactly at the validation clock-skew boundary", () => {
    const boundaryIssuedAt = new Date(verificationTime.getTime() + TAILNET_PROBE_CLOCK_SKEW_MS);
    const boundaryChallenge = tailnetProbeChallengeSchema.parse({
      version: TAILNET_PROBE_CHALLENGE_VERSION,
      nonce: nonce(4),
      issuedAt: boundaryIssuedAt.toISOString(),
      expiresAt: new Date(boundaryIssuedAt.getTime() + 60 * 60 * 1_000).toISOString()
    });
    const artifact = createTailnetProbeArtifact({
      ...passedArtifacts[0]!,
      generatedAt: verificationTime.toISOString(),
      expiresAt: new Date(boundaryIssuedAt.getTime() + 30 * 60 * 1_000).toISOString(),
      targetRunDigest: hashTailnetProbeChallenge(boundaryChallenge)
    });
    expect(
      validateTailnetProbeArtifactForChallenge(artifact, boundaryChallenge, verificationTime)
    ).toEqual(artifact);
  });

  it("rejects a Serve peer claim about Funnel state", () => {
    const unsigned = structuredClone(passedArtifacts[5]!) as Record<string, unknown>;
    (unsigned.observations as Record<string, unknown>).funnelAbsent = true;
    expect(unsignedTailnetProbeArtifactSchema.safeParse(unsigned).success).toBe(false);
  });

  it("rejects an oversized artifact before accepting unknown detail", () => {
    const artifact = {
      ...createTailnetProbeArtifact(passedArtifacts[0]!),
      detail: "x".repeat(TAILNET_PROBE_ARTIFACT_MAX_BYTES)
    };
    expect(() => parseTailnetProbeArtifact(artifact)).toThrow("tailnet_probe_artifact_invalid");
  });
});
