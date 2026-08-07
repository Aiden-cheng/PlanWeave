import { describe, expect, it } from "vitest";
import { resetRuntimeState } from "../runSessions/index.js";
import { remoteBlockOwnershipSchema } from "../schema/remoteOwnership.js";
import { createEmptyState, ensureStateForManifest, readState, writeState } from "../state.js";
import {
  markBlockBlocked,
  markBlockDiverged,
  resolveBlockDivergence,
  submitBlockResult
} from "../taskManager/index.js";
import {
  activateRemoteBlockOwnership,
  markRemoteBlockOwnershipSourceDrift,
  prepareRemoteBlockOwnership,
  RemoteOwnershipConflictError,
  withoutRemoteBlockOwnership
} from "../taskManager/remoteOwnershipTransitions.js";
import type { BlockState } from "../types.js";
import { basicManifest, createTestWorkspace, writeReport } from "./promptTestHelpers.js";

const source = {
  operationId: "operation-001",
  sourceRevision: "pgv-pkg-revision-001",
  graphFingerprint: "pkg-fingerprint-001"
};

function prepare(blockState: BlockState = { status: "ready" }) {
  return prepareRemoteBlockOwnership({
    blockType: "implementation",
    blockState,
    ownership: source
  });
}

describe("remote ownership schemas", () => {
  it("accepts bounded portable ownership and rejects private or transport fields", () => {
    expect(remoteBlockOwnershipSchema.parse({ phase: "preparing", ...source })).toEqual({
      phase: "preparing",
      ...source
    });
    expect(
      remoteBlockOwnershipSchema.safeParse({
        phase: "active",
        ...source,
        dispatchId: "dispatch-001",
        executionAttemptId: "attempt-001",
        hostId: "host-001"
      }).success
    ).toBe(false);
    expect(
      remoteBlockOwnershipSchema.safeParse({
        phase: "preparing",
        ...source,
        sourceRevision: "/Users/private/repository"
      }).success
    ).toBe(false);
  });
});

describe("remote ownership transitions", () => {
  it("prepares and activates one exact operation idempotently", () => {
    const prepared = prepare();
    expect(prepared).toEqual({
      status: "in_progress",
      remoteOwnership: { phase: "preparing", ...source }
    });
    expect(prepare(prepared)).toBe(prepared);

    const active = activateRemoteBlockOwnership({
      blockType: "implementation",
      blockState: prepared,
      ownership: {
        ...source,
        dispatchId: "dispatch-001",
        executionAttemptId: "attempt-001"
      }
    });
    expect(active.remoteOwnership).toEqual({
      phase: "active",
      ...source,
      dispatchId: "dispatch-001",
      executionAttemptId: "attempt-001"
    });
    expect(
      activateRemoteBlockOwnership({
        blockType: "implementation",
        blockState: active,
        ownership: {
          ...source,
          dispatchId: "dispatch-001",
          executionAttemptId: "attempt-001"
        }
      })
    ).toBe(active);
  });

  it("accepts review ownership and rejects local retrofit, foreign operations, and activation mismatch", () => {
    expect(
      prepareRemoteBlockOwnership({
        blockType: "review",
        blockState: { status: "ready" },
        ownership: source
      })
    ).toEqual({
      status: "in_progress",
      remoteOwnership: { phase: "preparing", ...source }
    });
    expect(() => prepare({ status: "in_progress" })).toThrow(/cannot be retroactively/i);

    const prepared = prepare();
    expect(() =>
      prepareRemoteBlockOwnership({
        blockType: "implementation",
        blockState: prepared,
        ownership: { ...source, operationId: "operation-foreign" }
      })
    ).toThrow(/conflicts with owner/i);
    expect(() =>
      activateRemoteBlockOwnership({
        blockType: "implementation",
        blockState: prepared,
        ownership: {
          ...source,
          sourceRevision: "pgv-pkg-revision-002",
          dispatchId: "dispatch-001",
          executionAttemptId: "attempt-001"
        }
      })
    ).toThrow(/source evidence/i);

    const active = activateRemoteBlockOwnership({
      blockType: "implementation",
      blockState: prepared,
      ownership: {
        ...source,
        dispatchId: "dispatch-001",
        executionAttemptId: "attempt-001"
      }
    });
    expect(() =>
      activateRemoteBlockOwnership({
        blockType: "implementation",
        blockState: active,
        ownership: {
          ...source,
          dispatchId: "dispatch-002",
          executionAttemptId: "attempt-002"
        }
      })
    ).toThrow(/already bound/i);
    expect(() => prepare({ ...prepared, status: "completed" })).toThrow(/cannot be retained/i);
  });

  it("retains identity on source drift, prevents reactivation, and clears terminal ownership", () => {
    const prepared = prepare();
    const diverged = markRemoteBlockOwnershipSourceDrift({
      blockType: "implementation",
      blockState: prepared,
      sourceRevision: "pgv-pkg-revision-002",
      graphFingerprint: "pkg-fingerprint-002",
      reason: "Plan Package changed during remote execution"
    });
    expect(diverged).toMatchObject({
      status: "diverged",
      divergenceReason: "Plan Package changed during remote execution",
      remoteOwnership: { phase: "preparing", operationId: source.operationId }
    });
    expect(() =>
      activateRemoteBlockOwnership({
        blockType: "implementation",
        blockState: diverged,
        ownership: {
          ...source,
          dispatchId: "dispatch-001",
          executionAttemptId: "attempt-001"
        }
      })
    ).toThrow(/cannot be activated/i);

    expect(withoutRemoteBlockOwnership(prepared, "completed")).toEqual({
      status: "completed"
    });
    expect(withoutRemoteBlockOwnership(prepared, "blocked")).toEqual({ status: "blocked" });
    expect(withoutRemoteBlockOwnership(diverged, "ready")).not.toHaveProperty("remoteOwnership");
  });
});

describe("remote ownership persistence consumers", () => {
  async function seedRemoteOwnership(options: { active?: boolean } = {}) {
    const workspace = await createTestWorkspace();
    const state = ensureStateForManifest(basicManifest(), createEmptyState());
    let blockState = prepare(state.blocks["T-001#B-001"]);
    if (options.active) {
      blockState = activateRemoteBlockOwnership({
        blockType: "implementation",
        blockState,
        ownership: {
          ...source,
          dispatchId: "dispatch-001",
          executionAttemptId: "attempt-001"
        }
      });
    }
    state.blocks["T-001#B-001"] = blockState;
    state.currentRefs = ["T-001#B-001"];
    await writeState(workspace.init.workspace.stateFile, state);
    return workspace;
  }

  it("blocks local submit from bypassing an exact remote owner", async () => {
    const { root, init } = await seedRemoteOwnership({ active: true });

    await expect(
      submitBlockResult({
        projectRoot: root,
        ref: "T-001#B-001",
        reportPath: await writeReport(root, "remote-local-submit.md")
      })
    ).rejects.toThrow(/must be completed through the remote operation port/i);

    await expect(readState(init.workspace.stateFile)).resolves.toMatchObject({
      blocks: {
        "T-001#B-001": {
          status: "in_progress",
          remoteOwnership: { operationId: source.operationId, dispatchId: "dispatch-001" }
        }
      }
    });
  });

  it("clears ownership on blocked and divergence-resolution terminal paths", async () => {
    const blockedWorkspace = await seedRemoteOwnership();
    await markBlockBlocked({
      projectRoot: blockedWorkspace.root,
      ref: "T-001#B-001",
      reason: "remote execution failed"
    });
    expect(
      (await readState(blockedWorkspace.init.workspace.stateFile)).blocks["T-001#B-001"]
    ).toEqual(expect.objectContaining({ status: "blocked" }));
    expect(
      (await readState(blockedWorkspace.init.workspace.stateFile)).blocks["T-001#B-001"]
    ).not.toHaveProperty("remoteOwnership");

    const divergedWorkspace = await seedRemoteOwnership({ active: true });
    await markBlockDiverged({
      projectRoot: divergedWorkspace.root,
      ref: "T-001#B-001",
      reason: "package changed"
    });
    const diverged = await readState(divergedWorkspace.init.workspace.stateFile);
    expect(diverged.blocks["T-001#B-001"]).toMatchObject({
      status: "diverged",
      remoteOwnership: { operationId: source.operationId, dispatchId: "dispatch-001" }
    });

    await resolveBlockDivergence({
      projectRoot: divergedWorkspace.root,
      ref: "T-001#B-001",
      reason: "operator reconciled the source"
    });
    const resolved = await readState(divergedWorkspace.init.workspace.stateFile);
    expect(resolved.blocks["T-001#B-001"]?.status).toBe("ready");
    expect(resolved.blocks["T-001#B-001"]).not.toHaveProperty("remoteOwnership");
  });

  it("requires force for active remote work and reset never retains ownership", async () => {
    const { root, init } = await seedRemoteOwnership({ active: true });
    await expect(resetRuntimeState({ projectRoot: root })).rejects.toThrow(/active work exists/i);

    await resetRuntimeState({ projectRoot: root, force: true });
    const reset = await readState(init.workspace.stateFile);
    expect(reset.blocks["T-001#B-001"]?.status).toBe("ready");
    expect(reset.blocks["T-001#B-001"]).not.toHaveProperty("remoteOwnership");
  });
});
