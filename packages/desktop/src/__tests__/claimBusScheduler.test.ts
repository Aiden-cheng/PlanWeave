import { describe, expect, it, vi } from "vitest";
import type { ClaimResult, DesktopAutoRunScope } from "@planweave-ai/runtime";
import {
  runClaimBusScope,
  type BlockExecutionPort,
  type ClaimPreviewPort,
  type EndpointRoutingPort,
  type FeedbackExecutionPort,
  type ScopeCompletionPort
} from "../renderer/collaboration/claimBusScheduler";

function blockClaim(ref: string): Extract<ClaimResult, { kind: "block" }> {
  const [taskId, blockId] = ref.split("#");
  return {
    kind: "block",
    ref,
    taskId: taskId ?? "T-001",
    blockId: blockId ?? "B-001",
    blockType: "implementation",
    effectiveExecutor: "default",
    reason: "claimed"
  };
}

function feedbackClaim(
  feedbackId = "FE-001"
): Extract<ClaimResult, { kind: "feedback" }> {
  return {
    kind: "feedback",
    feedbackId,
    sourceReviewBlockRef: "T-001#R-001",
    taskId: "T-001",
    content: "Please fix",
    effectiveExecutor: "default"
  };
}

function createPorts(options: {
  previews: ClaimResult[];
  satisfiedAfter?: number;
  alwaysSatisfied?: boolean;
  route?: EndpointRoutingPort["routeForBlock"];
}) {
  let previewIndex = 0;
  let satisfactionChecks = 0;
  const executedLocal: string[] = [];
  const executedRemote: string[] = [];
  const executedFeedback: string[] = [];

  const preview: ClaimPreviewPort = {
    previewNext: vi.fn(async (_scope: DesktopAutoRunScope) => {
      const next = options.previews[previewIndex];
      previewIndex += 1;
      if (!next) {
        return { kind: "none", reason: "no_claimable_blocks" };
      }
      return next;
    })
  };

  const localBlock: BlockExecutionPort = {
    execute: vi.fn(async (ref: string) => {
      executedLocal.push(ref);
    })
  };

  const remoteBlock: BlockExecutionPort = {
    execute: vi.fn(async (ref: string) => {
      executedRemote.push(ref);
    })
  };

  const feedback: FeedbackExecutionPort = {
    execute: vi.fn(async (claim) => {
      executedFeedback.push(claim.feedbackId);
    })
  };

  const completion: ScopeCompletionPort = {
    isSatisfied: vi.fn(async () => {
      satisfactionChecks += 1;
      if (options.alwaysSatisfied) {
        return true;
      }
      if (options.satisfiedAfter !== undefined) {
        return satisfactionChecks > options.satisfiedAfter;
      }
      return false;
    })
  };

  const route: EndpointRoutingPort = {
    routeForBlock: options.route ?? (() => "local")
  };

  return {
    preview,
    localBlock,
    remoteBlock,
    feedback,
    completion,
    route,
    executedLocal,
    executedRemote,
    executedFeedback
  };
}

describe("runClaimBusScope", () => {
  it("executes sequential blocks until none and scope is satisfied", async () => {
    const ports = createPorts({
      previews: [blockClaim("T-001#B-001"), blockClaim("T-001#B-002"), { kind: "none", reason: "done" }],
      // first isSatisfied before each unit (3 times) + once after final none
      satisfiedAfter: 3
    });

    await runClaimBusScope({
      scope: { kind: "project" },
      ...ports
    });

    expect(ports.executedLocal).toEqual(["T-001#B-001", "T-001#B-002"]);
    expect(ports.executedRemote).toEqual([]);
    expect(ports.preview.previewNext).toHaveBeenCalledTimes(3);
  });

  it("executes feedback units from claim order", async () => {
    const ports = createPorts({
      previews: [feedbackClaim("FE-001"), { kind: "none", reason: "idle" }],
      satisfiedAfter: 2
    });

    await runClaimBusScope({
      scope: { kind: "project" },
      ...ports
    });

    expect(ports.executedFeedback).toEqual(["FE-001"]);
    expect(ports.executedLocal).toEqual([]);
  });

  it("throws claim_bus_blocked without executing blocks", async () => {
    const ports = createPorts({
      previews: [{ kind: "blocked", reason: "dependency_incomplete", ref: "T-001#B-002" }]
    });

    await expect(
      runClaimBusScope({
        scope: { kind: "project" },
        ...ports
      })
    ).rejects.toThrow("claim_bus_blocked:dependency_incomplete");

    expect(ports.localBlock.execute).not.toHaveBeenCalled();
    expect(ports.remoteBlock.execute).not.toHaveBeenCalled();
  });

  it("throws claim_bus_idle when none while scope is not satisfied", async () => {
    const ports = createPorts({
      previews: [{ kind: "none", reason: "no_claimable_blocks" }],
      alwaysSatisfied: false
    });

    await expect(
      runClaimBusScope({
        scope: { kind: "project" },
        ...ports
      })
    ).rejects.toThrow("claim_bus_idle:no_claimable_blocks");

    expect(ports.completion.isSatisfied).toHaveBeenNthCalledWith(2, { refresh: true });
  });

  it("refreshes completion after claim none before judging idle vs complete", async () => {
    const optionsSeen: Array<{ refresh?: boolean } | undefined> = [];
    let checks = 0;
    const ports = createPorts({
      previews: [{ kind: "none", reason: "no_claimable_blocks" }]
    });
    ports.completion.isSatisfied = vi.fn(async (options) => {
      optionsSeen.push(options);
      checks += 1;
      // Stale first check is incomplete; refreshed check after none becomes complete.
      return checks >= 2;
    });

    await expect(
      runClaimBusScope({
        scope: { kind: "project" },
        ...ports
      })
    ).resolves.toBeUndefined();

    expect(optionsSeen).toEqual([undefined, { refresh: true }]);
    expect(ports.localBlock.execute).not.toHaveBeenCalled();
  });

  it("returns successfully when none while scope is satisfied", async () => {
    let checks = 0;
    const ports = createPorts({
      previews: [{ kind: "none", reason: "no_claimable_blocks" }]
    });
    ports.completion.isSatisfied = vi.fn(async () => {
      checks += 1;
      // first loop check false so we preview; after none, true
      return checks >= 2;
    });

    await expect(
      runClaimBusScope({
        scope: { kind: "project" },
        ...ports
      })
    ).resolves.toBeUndefined();

    expect(ports.completion.isSatisfied).toHaveBeenNthCalledWith(2, { refresh: true });
    expect(ports.localBlock.execute).not.toHaveBeenCalled();
  });

  it("routes remote vs local to the correct execution port", async () => {
    const ports = createPorts({
      previews: [blockClaim("T-001#B-001"), blockClaim("T-001#B-002"), { kind: "none", reason: "done" }],
      satisfiedAfter: 3,
      route: (ref) => (ref === "T-001#B-001" ? "remote" : "local")
    });

    await runClaimBusScope({
      scope: { kind: "project" },
      ...ports
    });

    expect(ports.executedRemote).toEqual(["T-001#B-001"]);
    expect(ports.executedLocal).toEqual(["T-001#B-002"]);
  });

  it("executes batch refs serially", async () => {
    const ports = createPorts({
      previews: [
        {
          kind: "batch",
          refs: ["T-001#B-001", "T-002#B-001"],
          effectiveExecutors: {
            "T-001#B-001": "default",
            "T-002#B-001": "default"
          }
        },
        { kind: "none", reason: "done" }
      ],
      satisfiedAfter: 2
    });

    await runClaimBusScope({
      scope: { kind: "project" },
      ...ports
    });

    expect(ports.executedLocal).toEqual(["T-001#B-001", "T-002#B-001"]);
    expect(ports.localBlock.execute).toHaveBeenCalledTimes(2);
  });

  it("treats batch at_capacity as idle and does not re-dispatch live refs", async () => {
    const ports = createPorts({
      previews: [
        {
          kind: "batch",
          refs: ["T-001#B-001"],
          effectiveExecutors: { "T-001#B-001": "default" },
          reason: "at_capacity"
        }
      ],
      alwaysSatisfied: false
    });

    await expect(
      runClaimBusScope({
        scope: { kind: "project" },
        ...ports
      })
    ).rejects.toThrow(/claim_bus_idle:at_capacity/);
    expect(ports.completion.isSatisfied).toHaveBeenNthCalledWith(2, { refresh: true });
    expect(ports.localBlock.execute).not.toHaveBeenCalled();
    expect(ports.remoteBlock.execute).not.toHaveBeenCalled();
  });

  it("throws claim_bus_cancelled when aborted mid-loop", async () => {
    const controller = new AbortController();
    const ports = createPorts({
      previews: [blockClaim("T-001#B-001"), blockClaim("T-001#B-002")]
    });
    ports.localBlock.execute = vi.fn(async (ref: string) => {
      ports.executedLocal.push(ref);
      controller.abort();
    });

    await expect(
      runClaimBusScope({
        scope: { kind: "project" },
        ...ports,
        signal: controller.signal
      })
    ).rejects.toThrow("claim_bus_cancelled");

    expect(ports.executedLocal).toEqual(["T-001#B-001"]);
  });
});
