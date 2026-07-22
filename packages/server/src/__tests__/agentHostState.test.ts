import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAgentHostState, type AgentHostState } from "../agentHostState.js";

const directories: string[] = [];
const states: AgentHostState[] = [];

afterEach(async () => {
  for (const state of states.splice(0)) state.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup(): Promise<{ directory: string; state: AgentHostState }> {
  const directory = await mkdtemp(join(tmpdir(), "planweave-agent-host-state-"));
  directories.push(directory);
  const state = await openAgentHostState(join(directory, "host.sqlite"));
  states.push(state);
  return { directory, state };
}

function executeMessage(sequence = 1) {
  return {
    type: "mailbox.message" as const,
    sequence,
    messageId: `mailbox-${sequence}`,
    command: {
      type: "execute_block" as const,
      dispatchId: "dispatch-1",
      leaseId: "lease-1",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      projectId: "project-1",
      blockRef: "T-001#B-001",
      packageRef: "package://project-1/v1",
      requiredCapabilities: ["linux"]
    }
  };
}

function cancelMessage(sequence = 2) {
  return {
    type: "mailbox.message" as const,
    sequence,
    messageId: `mailbox-${sequence}`,
    command: {
      type: "cancel_execution" as const,
      dispatchId: "dispatch-1",
      leaseId: "lease-1",
      reason: "The task was reassigned."
    }
  };
}

describe("durable Agent Host state", () => {
  it("persists a mailbox command before advancing its acknowledged cursor", async () => {
    const { directory, state } = await setup();
    const received = state.receive(executeMessage());
    expect(received.stored).toBe(true);
    expect(state.pendingExecutions(1)).toHaveLength(1);
    expect(state.lastAcknowledgedSequence()).toBe(0);
    expect(state.pendingEvents()).toContainEqual(received.acknowledgement);

    state.close();
    states.pop();
    const reopened = await openAgentHostState(join(directory, "host.sqlite"));
    states.push(reopened);
    expect(reopened.pendingExecutions(1)).toHaveLength(1);
    expect(reopened.lastAcknowledgedSequence()).toBe(0);

    reopened.acknowledgeEvent(received.acknowledgement.messageId);
    expect(reopened.lastAcknowledgedSequence()).toBe(1);
  });

  it("deduplicates replayed messages and rejects conflicting sequence reuse", async () => {
    const { state } = await setup();
    const message = executeMessage();
    const first = state.receive(message);
    const replay = state.receive(message);
    expect(replay).toEqual({ stored: false, acknowledgement: first.acknowledgement });

    expect(() => state.receive({ ...message, messageId: "mailbox-conflict" })).toThrowError(
      "mailbox_message_conflict"
    );
  });

  it("atomically persists execution lifecycle events and recovers interrupted work", async () => {
    const { directory, state } = await setup();
    state.receive(executeMessage());
    const execution = state.startExecution(1);
    expect(execution?.status).toBe("running");
    expect(state.pendingEvents()).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "dispatch.accepted" })])
    );

    state.close();
    states.pop();
    const reopened = await openAgentHostState(join(directory, "host.sqlite"));
    states.push(reopened);
    expect(reopened.recoverInterruptedExecutions()).toBe(1);
    expect(reopened.startExecution(1)?.status).toBe("running");
    reopened.completeExecution(1, {
      summary: "Remote execution completed.",
      reportArtifactRef: `artifact:sha256:${"a".repeat(64)}`,
      artifactRefs: []
    });

    expect(reopened.pendingExecutions(1)).toEqual([]);
    expect(reopened.activeLeases()).toEqual([]);
    expect(reopened.pendingEvents()).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "dispatch.completed" })])
    );
    expect(reopened.startExecution(1)).toBeUndefined();
  });

  it("persists cancellation and does not restart cancelled work after a crash", async () => {
    const { directory, state } = await setup();
    state.receive(executeMessage());
    state.startExecution(1);
    state.receive(cancelMessage());
    expect(state.pendingCancellations()).toHaveLength(1);
    expect(state.applyCancellation(2)).toEqual({ shouldAbort: true });

    state.close();
    states.pop();
    const reopened = await openAgentHostState(join(directory, "host.sqlite"));
    states.push(reopened);
    expect(reopened.recoverInterruptedExecutions()).toBe(1);
    expect(reopened.pendingExecutions(1)).toEqual([]);
    expect(reopened.pendingEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "dispatch.failed",
          failure: expect.objectContaining({ code: "execution_cancelled" })
        })
      ])
    );
  });

  it("tracks lease renewals and abandons expired local execution", async () => {
    const { state } = await setup();
    state.receive(executeMessage());
    const renewedUntil = new Date(Date.now() + 120_000).toISOString();
    expect(state.renewLease("dispatch-1", "lease-1", renewedUntil)).toBe(true);
    expect(state.pendingExecutions(1)[0]?.command.leaseExpiresAt).toBe(renewedUntil);
    expect(state.abandonExpiredExecutions(new Date(Date.now() + 60_000))).toEqual([]);

    const expired = state.abandonExpiredExecutions(new Date(Date.now() + 180_000));
    expect(expired).toHaveLength(1);
    expect(state.activeLeases()).toEqual([]);
    expect(state.pendingExecutions(1)).toEqual([]);
  });
});
