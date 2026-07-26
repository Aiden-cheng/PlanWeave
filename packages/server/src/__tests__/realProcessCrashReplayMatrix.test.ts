/**
 * Real multi-process crash/replay fault matrix (RV-002#B-003).
 *
 * Injects process/ACP failures at public durable boundaries, restarts the
 * affected process, and asserts one documented reconciliation outcome:
 * no duplicate ACP turn and no false terminal success.
 *
 * In-process Coordinator checkpoint matrix remains in
 * remoteBlockCoordinatorCrash.test.ts; this file covers process-level Host/Server/ACP.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  RealProcessAcpHarness,
  remoteAcpManifestParallelCapacity,
  type RealProcessAcpHarnessOptions
} from "./support/realProcessAcpHarness.js";
import { RealProcessLifecycleClient } from "./support/realProcessLifecycleClient.js";

const harnesses: RealProcessAcpHarness[] = [];

afterEach(async () => {
  await Promise.all(
    harnesses.splice(0).map(async (harness) => {
      await harness.dispose();
    })
  );
});

async function createHarness(
  options: RealProcessAcpHarnessOptions = {}
): Promise<{ harness: RealProcessAcpHarness; client: RealProcessLifecycleClient }> {
  const harness = await RealProcessAcpHarness.create({
    acpScenario: "success",
    readinessTimeoutMs: 20_000,
    ...options
  });
  harnesses.push(harness);
  return { harness, client: new RealProcessLifecycleClient(harness, 90_000) };
}

function assertNotFalseSuccess(view: {
  state: string;
  dispatchStatus?: string;
  runtime: { status: string; terminalReceipt?: { outcome: string } };
}): void {
  expect(view.state).not.toBe("completed");
  expect(view.dispatchStatus).not.toBe("completed");
  expect(view.runtime.status).not.toBe("completed");
  if (view.runtime.terminalReceipt) {
    expect(view.runtime.terminalReceipt.outcome).not.toBe("completed");
  }
}

describe("real-process crash/replay fault matrix", () => {
  it("Host kill at ACP session/prompt: recovery does not auto-rerun ACP or false-complete", async () => {
    const { harness, client } = await createHarness({ hostCapacity: 1 });
    await harness.startAll();
    await harness.acpControl.pause(["session/prompt"]);

    const dispatched = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "fault-host-kill-1"
    });
    await harness.acpControl.waitUntilLifecycleContains("paused session/prompt", 30_000);
    await client.waitForDispatchStatus(dispatched.operationId, ["running", "leased"]);

    const sessionNewBefore = client.countLifecycleFragment("session/new");
    const promptBefore = client.countLifecycleFragment("session/prompt");
    expect(sessionNewBefore).toBe(1);
    // Barrier records "paused session/prompt" before the successful prompt line.
    expect(promptBefore).toBeGreaterThanOrEqual(1);

    await harness.killHost("SIGKILL");
    // Sensitivity: if Host auto-reran ACP on restart without operator resume, session/new would increase.
    // restartHost waits for a refreshed lastSeenAt so the Host has reconnected before we judge recovery.
    await harness.restartHost();

    // Host recovery reports interruption rather than inventing terminal success.
    // Do not accept pre-durable states (running/leased) or awaiting_writeback without interruption —
    // those can appear before the Host durable boundary is reconciled.
    const after = await client.waitForOperation(
      dispatched.operationId,
      (view) => {
        if (view.state === "completed" || view.dispatchStatus === "completed") return false;
        const durableState = ["interrupted", "action_required", "failed", "cancelled"].includes(
          view.state
        );
        const durableDispatch = ["interrupted", "failed", "cancelled"].includes(
          String(view.dispatchStatus)
        );
        const durableAttempt =
          view.attempt.status === "interrupted" || view.attempt.status === "action_required";
        return durableState || durableDispatch || durableAttempt;
      },
      "host-kill-reconciled"
    );
    assertNotFalseSuccess(after);

    const sessionNewAfter = client.countLifecycleFragment("session/new");
    expect(sessionNewAfter).toBe(sessionNewBefore);

    // Same operation identity retained; no second active attempt invented.
    expect(after.operationId).toBe(dispatched.operationId);
    expect(after.dispatchId).toBe(dispatched.dispatchId);
    expect(after.executionAttemptId).toBe(dispatched.executionAttemptId);
    expect(client.countServerRows("remote_execution_attempts")).toBe(1);
    expect(client.countServerRows("dispatches")).toBe(1);
  }, 120_000);

  it("Server kill during ACP barrier then restart: no false success; at most one ACP session", async () => {
    const { harness, client } = await createHarness();
    await harness.startAll();
    await harness.acpControl.pause(["session/prompt"]);

    const dispatched = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "fault-server-kill-1"
    });
    await harness.acpControl.waitUntilLifecycleContains("paused session/prompt", 30_000);
    await client.waitForDispatchStatus(dispatched.operationId, ["running", "leased"]);
    const sessionNewBefore = client.countLifecycleFragment("session/new");
    expect(sessionNewBefore).toBe(1);

    await harness.killServer("SIGKILL");
    await harness.restartServer();
    // Host reconnects against preserved SQLite; resume ACP barrier so any live child can finish or interrupt.
    await harness.acpControl.resume();

    // After Server restart, either the same attempt progresses to a real terminal or stays non-success.
    // Poll until Server is queryable and the operation is not falsely completed without evidence.
    // Critical: countLifecycleFragment("session/prompt") matches "paused session/prompt" at the
    // barrier and would satisfy too early — require the exact post-barrier session/prompt event.
    const view = await client.waitForOperation(
      dispatched.operationId,
      (current) => {
        if (current.state === "completed") {
          const promptCompleted = client.countLifecycleExactEvent("session/prompt") >= 1;
          const receiptOk = current.runtime.terminalReceipt?.outcome === "completed";
          return promptCompleted && receiptOk;
        }
        return [
          "failed",
          "cancelled",
          "interrupted",
          "action_required",
          "activated",
          "claimed"
        ].includes(current.state);
      },
      "server-kill-reconciled"
    );

    if (view.state === "completed") {
      // Real success path: identities stable, single attempt, single report link.
      expect(view.dispatchId).toBe(dispatched.dispatchId);
      expect(view.executionAttemptId).toBe(dispatched.executionAttemptId);
      expect(client.countServerRows("remote_execution_attempts")).toBe(1);
      expect(client.countLifecycleExactEvent("session/new")).toBe(1);
      expect(client.countLifecycleExactEvent("session/prompt")).toBeGreaterThanOrEqual(1);
      // Barrier lines must not be mistaken for completion evidence.
      expect(client.countLifecycleExactEvent("paused session/prompt")).toBeGreaterThanOrEqual(1);
    } else {
      assertNotFalseSuccess(view);
      // No second ACP turn invented while Server was down.
      expect(client.countLifecycleExactEvent("session/new")).toBe(sessionNewBefore);
    }
  }, 120_000);

  it("ACP force-exit mid-prompt fails closed without terminal success", async () => {
    const { harness, client } = await createHarness({ acpScenario: "success" });
    await harness.startAll();
    await harness.acpControl.pause(["session/prompt"]);

    const dispatched = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "fault-acp-exit-1"
    });
    await harness.acpControl.waitUntilLifecycleContains("paused session/prompt", 30_000);
    // Keep the barrier in place so the mock ACP loop observes force-exit and exits.
    // Resuming first would race and allow a clean prompt completion (false success).
    await harness.acpControl.forceExit(42);

    const terminal = await client.waitForTerminal(dispatched.operationId);
    assertNotFalseSuccess(terminal);
    expect(["failed", "cancelled"]).toContain(terminal.state);
    expect(terminal.runtime.terminalReceipt?.outcome).not.toBe("completed");
    expect(client.readServerDispatch(dispatched.dispatchId).result_json).toBeNull();
    // Sensitivity: a success-biased assertion would only check terminal existence.
    expect(client.countLifecycleFragment("session/new")).toBe(1);
  }, 120_000);

  it("Server restart after terminal preserves completed state without replaying ACP", async () => {
    const { harness, client } = await createHarness();
    await harness.startAll();
    const dispatched = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "fault-terminal-restart-1"
    });
    const terminal = await client.waitForTerminal(dispatched.operationId);
    expect(terminal.state).toBe("completed");
    const sessionNew = client.countLifecycleFragment("session/new");
    expect(sessionNew).toBe(1);

    await harness.restartServer();
    const after = await client.observe(dispatched.operationId);
    expect(after.state).toBe("completed");
    expect(after.dispatchId).toBe(dispatched.dispatchId);
    expect(after.executionAttemptId).toBe(dispatched.executionAttemptId);
    expect(after.runtime.terminalReceipt?.outcome).toBe("completed");
    // Sensitivity: if restart re-dispatched execute, session/new would rise.
    expect(client.countLifecycleFragment("session/new")).toBe(sessionNew);
    expect(client.countServerRows("dispatches", "status=?", ["completed"])).toBe(1);
  }, 120_000);

  it("capacity contention: one Host capacity=1 activates only one of two Blocks", async () => {
    const { harness, client } = await createHarness({
      hostCapacity: 1,
      manifest: remoteAcpManifestParallelCapacity(),
      // Pause ACP so capacity stays reserved while the second block dispatches.
      acpScenario: "success"
    });
    await harness.startAll();
    await harness.acpControl.pause(["session/prompt"]);

    const first = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "fault-capacity-a"
    });
    await client.waitForDispatchStatus(first.operationId, ["leased", "running"]);

    const second = await client.dispatch({
      blockRef: "T-002#B-001",
      idempotencyKey: "fault-capacity-b"
    });
    // Second remains claimed/awaiting host capacity (no second reservation).
    expect(["claimed", "activated"]).toContain(second.state);
    if (second.state === "claimed") {
      expect(second.dispatchStatus).toBeUndefined();
      const diagnostic = client.readOperationDiagnostic(second.operationId);
      expect(diagnostic.diagnostic_code).toMatch(/no_compatible|capacity|host/i);
    }
    expect(client.countServerRows("host_capacity_reservations")).toBe(1);
    expect(client.countServerRows("mailbox_messages")).toBe(1);

    await harness.acpControl.resume();
    const firstTerminal = await client.waitForTerminal(first.operationId);
    expect(firstTerminal.state).toBe("completed");

    // After capacity frees, re-dispatch second should progress.
    const secondActivated = await client.dispatch({
      blockRef: "T-002#B-001",
      idempotencyKey: "fault-capacity-b"
    });
    expect(secondActivated.operationId).toBe(second.operationId);
    const secondTerminal = await client.waitForTerminal(second.operationId);
    expect(secondTerminal.state).toBe("completed");
    expect(secondTerminal.operationId).not.toBe(first.operationId);
  }, 180_000);

  it("concurrent identical idempotency collapses to one logical remote operation", async () => {
    const { harness, client } = await createHarness({ hostCapacity: 2 });
    await harness.startAll();
    const key = "fault-idempotent-1";
    const [a, b] = await Promise.all([
      client.dispatch({ blockRef: "T-001#B-001", idempotencyKey: key }),
      client.dispatch({ blockRef: "T-001#B-001", idempotencyKey: key })
    ]);
    expect(a.operationId).toBe(b.operationId);
    expect(a.dispatchId).toBe(b.dispatchId);
    expect(a.executionAttemptId).toBe(b.executionAttemptId);
    expect(client.countServerRows("remote_operations")).toBe(1);
    expect(client.countServerRows("remote_execution_attempts")).toBe(1);
    const terminal = await client.waitForTerminal(a.operationId);
    expect(terminal.state).toBe("completed");
    expect(client.countLifecycleFragment("session/new")).toBe(1);
  }, 120_000);

  it("cancel vs ACP barrier race settles cancelled without success", async () => {
    const { harness, client } = await createHarness();
    await harness.startAll();
    await harness.acpControl.pause(["session/prompt"]);
    const dispatched = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "fault-cancel-race-1"
    });
    await harness.acpControl.waitUntilLifecycleContains("paused session/prompt", 30_000);
    await client.cancel(dispatched.operationId, "matrix cancel race");
    await harness.acpControl.resume();
    const terminal = await client.waitForTerminal(dispatched.operationId);
    expect(terminal.state).toBe("cancelled");
    assertNotFalseSuccess(terminal);
    // Sensitivity: success-only wait would hide a cancelled-but-marked-completed bug.
    expect(client.readServerDispatch(dispatched.dispatchId).status).toBe("cancelled");
  }, 120_000);
});
