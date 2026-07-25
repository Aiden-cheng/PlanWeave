/**
 * Real multi-process adversarial authorization matrix (RV-002#B-003).
 *
 * Exercises public operator HTTP APIs against a live Server + Host topology.
 * Complementary Host/artifact matrices live in artifactAdversarialBoundary.test.ts
 * and agent-host unit recovery/auth suites; this file proves process-level operator
 * and action identity fences with sensitivity checks (safe vs unsafe variants).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  RealProcessAcpHarness,
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

type MatrixCase = {
  name: string;
  run: (ctx: {
    harness: RealProcessAcpHarness;
    client: RealProcessLifecycleClient;
    operationId: string;
    dispatchId: string;
    executionAttemptId: string;
    leaseId: string;
    stateVersion: number;
  }) => Promise<void>;
};

/** Fail-closed HTTP statuses for adversarial operator probes (includes unmapped 500). */
function assertDenied(
  response: { status: number; body: unknown },
  allowed: readonly number[] = [400, 401, 403, 404, 409, 413, 422, 500]
): void {
  expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(400);
  expect(allowed, JSON.stringify(response.body)).toContain(response.status);
  // Never accept a success-shaped body for a denial probe.
  expect(response.status).not.toBe(202);
  expect(response.status).not.toBe(200);
}

function assertActionNotEffected(
  client: RealProcessLifecycleClient,
  actionId: string,
  dispatchId: string
): void {
  const settled = client.countServerRows(
    "remote_execution_actions",
    "action_id=? AND state IN ('delivered','acknowledged','settled')",
    [actionId]
  );
  expect(settled).toBe(0);
  expect(client.readServerDispatch(dispatchId).status).not.toBe("cancelled");
  expect(client.readServerDispatch(dispatchId).status).not.toBe("completed");
}

describe("real-process adversarial authorization matrix", () => {
  it("operator and action identity fence matrix (wrong principal/scope/lease/version/schema/cursor)", async () => {
    const { harness, client } = await createHarness();
    await harness.startAll();
    await harness.acpControl.pause(["session/prompt"]);

    const dispatched = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "auth-matrix-1"
    });
    await client.waitForDispatchStatus(dispatched.operationId, ["leased", "running"]);
    // ACP barrier is session/prompt, so session/new is durable before probes begin.
    await harness.acpControl.waitUntilLifecycleContains("paused session/prompt", 30_000);
    const view = await client.observe(dispatched.operationId);
    const leaseId = view.attempt.leaseId;
    expect(leaseId).toEqual(expect.any(String));

    const ctx = {
      harness,
      client,
      operationId: view.operationId,
      dispatchId: view.dispatchId,
      executionAttemptId: view.executionAttemptId,
      leaseId: leaseId!,
      stateVersion: view.attempt.stateVersion
    };

    const cases: MatrixCase[] = [
      {
        name: "missing Authorization",
        run: async ({ client: c, operationId }) => {
          const denied = await c.rawRequest({
            method: "GET",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}`,
            authorization: null
          });
          expect(denied.status).toBe(401);
          // Sensitivity: authenticated observation must succeed.
          const allowed = await c.rawRequest({
            method: "GET",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}`
          });
          expect(allowed.status).toBe(200);
        }
      },
      {
        name: "wrong operator token",
        run: async ({ client: c, operationId }) => {
          const denied = await c.rawRequest({
            method: "GET",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}`,
            authorization: "definitely-not-the-harness-token"
          });
          expect(denied.status).toBe(401);
          const allowed = await c.rawRequest({
            method: "GET",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}`
          });
          expect(allowed.status).toBe(200);
        }
      },
      {
        name: "wrong projectId on create",
        run: async ({ client: c }) => {
          const before = c.countServerRows("remote_operations");
          const denied = await c.rawRequest({
            method: "POST",
            path: "/api/v1/remote-operations",
            body: {
              projectId: "foreign-project-id",
              canvasId: "default",
              blockRef: "T-001#B-001",
              idempotencyKey: "auth-wrong-project"
            }
          });
          // serverAdmin bypasses project scope; unknown project fails closed (often 500/404).
          assertDenied(denied, [403, 404, 500]);
          expect(c.countServerRows("remote_operations")).toBe(before);
          // Sensitivity: trusted project idempotent replay succeeds.
          const trusted = await c.rawRequest({
            method: "POST",
            path: "/api/v1/remote-operations",
            body: {
              projectId: c.harness.projectId,
              canvasId: "default",
              blockRef: "T-001#B-001",
              idempotencyKey: "auth-matrix-1"
            }
          });
          expect(trusted.status).toBe(202);
        }
      },
      {
        name: "unknown operation observe",
        run: async ({ client: c }) => {
          const denied = await c.rawRequest({
            method: "GET",
            path: `/api/v1/remote-operations/${encodeURIComponent("operation-does-not-exist")}`
          });
          assertDenied(denied, [404, 403]);
        }
      },
      {
        name: "action with wrong leaseId",
        run: async ({ client: c, operationId, dispatchId, executionAttemptId, stateVersion }) => {
          const denied = await c.rawRequest({
            method: "POST",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}/actions`,
            body: {
              actionId: "auth-wrong-lease",
              operationId,
              dispatchId,
              executionAttemptId,
              expectedAttemptVersion: stateVersion,
              kind: "cancel",
              leaseId: "lease-foreign",
              reason: "wrong lease attack"
            }
          });
          // Action rows may be recorded before validation; they must not deliver or cancel.
          assertDenied(denied, [400, 409, 422, 500]);
          assertActionNotEffected(c, "auth-wrong-lease", dispatchId);
        }
      },
      {
        name: "action with wrong dispatchId",
        run: async ({
          client: c,
          operationId,
          dispatchId,
          executionAttemptId,
          leaseId,
          stateVersion
        }) => {
          const denied = await c.rawRequest({
            method: "POST",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}/actions`,
            body: {
              actionId: "auth-wrong-dispatch",
              operationId,
              dispatchId: "dispatch-foreign",
              executionAttemptId,
              expectedAttemptVersion: stateVersion,
              kind: "cancel",
              leaseId,
              reason: "wrong dispatch attack"
            }
          });
          assertDenied(denied, [400, 409, 422, 500]);
          assertActionNotEffected(c, "auth-wrong-dispatch", dispatchId);
        }
      },
      {
        name: "action with wrong executionAttemptId",
        run: async ({ client: c, operationId, dispatchId, leaseId, stateVersion }) => {
          const denied = await c.rawRequest({
            method: "POST",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}/actions`,
            body: {
              actionId: "auth-wrong-attempt",
              operationId,
              dispatchId,
              executionAttemptId: "attempt-foreign",
              expectedAttemptVersion: stateVersion,
              kind: "cancel",
              leaseId,
              reason: "wrong attempt attack"
            }
          });
          assertDenied(denied, [400, 409, 422, 500]);
          assertActionNotEffected(c, "auth-wrong-attempt", dispatchId);
        }
      },
      {
        name: "action with stale expectedAttemptVersion",
        run: async ({
          client: c,
          operationId,
          dispatchId,
          executionAttemptId,
          leaseId,
          stateVersion
        }) => {
          const denied = await c.rawRequest({
            method: "POST",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}/actions`,
            body: {
              actionId: "auth-stale-version",
              operationId,
              dispatchId,
              executionAttemptId,
              // Always diverge from the live attempt version (0 is a valid version).
              expectedAttemptVersion: stateVersion === 0 ? 1 : stateVersion - 1,
              kind: "cancel",
              leaseId,
              reason: "stale version attack"
            }
          });
          assertDenied(denied, [409, 400, 422, 500]);
          assertActionNotEffected(c, "auth-stale-version", dispatchId);
        }
      },
      {
        name: "invalid schema / missing required action fields",
        run: async ({ client: c, operationId }) => {
          const denied = await c.rawRequest({
            method: "POST",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}/actions`,
            body: { kind: "cancel" }
          });
          assertDenied(denied, [400, 409, 422]);
        }
      },
      {
        name: "malformed JSON body",
        run: async ({ client: c, operationId }) => {
          const denied = await c.rawRequest({
            method: "POST",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}/actions`,
            body: "{not-json",
            headers: { "content-type": "application/json" }
          });
          expect(denied.status).toBe(400);
        }
      },
      {
        name: "out-of-order / invalid event cursor",
        run: async ({ client: c, operationId }) => {
          const negative = await c.rawRequest({
            method: "GET",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}/events?afterCursor=-1`
          });
          // Zod rejects negative; missing stream can surface 404 before validation differences matter.
          assertDenied(negative, [400, 404, 422]);

          const huge = await c.rawRequest({
            method: "GET",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}/events?afterCursor=999999`
          });
          // Cursor beyond high-watermark fails closed (404/400/409) or empty-safe 200.
          if (huge.status === 200) {
            const body = huge.body as { events?: unknown[] };
            expect(body.events ?? []).toEqual([]);
          } else {
            assertDenied(huge, [400, 404, 422, 409]);
          }

          // At the ACP barrier the event stream may not exist yet (404). When present, cursor 0 is valid.
          const zero = await c.rawRequest({
            method: "GET",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}/events?afterCursor=0`
          });
          expect([200, 404]).toContain(zero.status);
          if (zero.status === 200) {
            // Sensitivity: invalid negative stays denied even when zero works.
            expect(negative.status).not.toBe(200);
          }
        }
      },
      {
        name: "invalid hosts pagination",
        run: async ({ client: c }) => {
          const denied = await c.rawRequest({
            method: "GET",
            path: "/api/v1/hosts?limit=1&limit=2"
          });
          expect(denied.status).toBe(400);
          const allowed = await c.rawRequest({
            method: "GET",
            path: "/api/v1/hosts?cursor=0&limit=50"
          });
          expect(allowed.status).toBe(200);
        }
      },
      {
        name: "interaction respond with wrong dispatch identity",
        run: async ({ client: c, operationId, leaseId, executionAttemptId }) => {
          const denied = await c.rawRequest({
            method: "POST",
            path: `/api/v1/remote-operations/${encodeURIComponent(operationId)}/interactions/respond`,
            body: {
              type: "interaction.permission_response",
              actionId: "permission:fabricated",
              dispatchId: "dispatch-foreign",
              leaseId,
              executionAttemptId,
              acpSessionId: "session-fabricated",
              decision: "allow_once"
            }
          });
          assertDenied(denied, [400, 403, 404, 409, 422, 500]);
        }
      }
    ];

    const results: Array<{ name: string; ok: boolean; error?: string }> = [];
    for (const entry of cases) {
      try {
        await entry.run(ctx);
        results.push({ name: entry.name, ok: true });
      } catch (error) {
        results.push({
          name: entry.name,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    const failed = results.filter((result) => !result.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);

    // Operation must remain non-terminal success after adversarial probes (still at barrier).
    const stillLive = await client.observe(dispatched.operationId);
    expect(stillLive.state).not.toBe("completed");
    expect(client.countLifecycleFragment("session/new")).toBe(1);

    await harness.acpControl.resume();
    const terminal = await client.waitForTerminal(dispatched.operationId);
    expect(terminal.state).toBe("completed");

    // Post-terminal sensitivity: legitimate cursor 0 succeeds; negative and ahead fail closed.
    const zeroAfter = await client.rawRequest({
      method: "GET",
      path: `/api/v1/remote-operations/${encodeURIComponent(dispatched.operationId)}/events?afterCursor=0`
    });
    expect(zeroAfter.status).toBe(200);
    const negativeAfter = await client.rawRequest({
      method: "GET",
      path: `/api/v1/remote-operations/${encodeURIComponent(dispatched.operationId)}/events?afterCursor=-1`
    });
    assertDenied(negativeAfter, [400, 422]);
    const body = zeroAfter.body as { highWatermark?: number };
    const ahead = (body.highWatermark ?? 0) + 10;
    const aheadAfter = await client.rawRequest({
      method: "GET",
      path: `/api/v1/remote-operations/${encodeURIComponent(dispatched.operationId)}/events?afterCursor=${ahead}`
    });
    // cursor_ahead is fail-closed; HTTP mapping may still be unmapped 500.
    assertDenied(aheadAfter, [400, 404, 409, 422, 500]);
  }, 180_000);

  it("action after terminal rejects further cancel without rewriting success", async () => {
    const { harness, client } = await createHarness();
    await harness.startAll();
    const dispatched = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "auth-after-deadline-1"
    });
    const terminal = await client.waitForTerminal(dispatched.operationId);
    expect(terminal.state).toBe("completed");
    const leaseId = terminal.attempt.leaseId;
    expect(leaseId).toEqual(expect.any(String));

    const denied = await client.rawRequest({
      method: "POST",
      path: `/api/v1/remote-operations/${encodeURIComponent(terminal.operationId)}/actions`,
      body: {
        actionId: "auth-after-terminal-cancel",
        operationId: terminal.operationId,
        dispatchId: terminal.dispatchId,
        executionAttemptId: terminal.executionAttemptId,
        expectedAttemptVersion: terminal.attempt.stateVersion,
        kind: "cancel",
        leaseId,
        reason: "after terminal"
      }
    });
    assertDenied(denied, [400, 409, 422, 500]);

    const still = await client.observe(terminal.operationId);
    expect(still.state).toBe("completed");
    expect(still.runtime.terminalReceipt?.outcome).toBe("completed");
    expect(client.readServerDispatch(terminal.dispatchId).status).toBe("completed");
  }, 120_000);

  it("foreign block ownership: second idempotency key cannot hijack active claim", async () => {
    const { harness, client } = await createHarness({ hostCapacity: 1 });
    await harness.startAll();
    await harness.acpControl.pause(["session/prompt"]);

    const owner = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "auth-owner-a"
    });
    await client.waitForDispatchStatus(owner.operationId, ["leased", "running"]);

    const hijack = await client.rawRequest({
      method: "POST",
      path: "/api/v1/remote-operations",
      body: {
        projectId: harness.projectId,
        canvasId: "default",
        blockRef: "T-001#B-001",
        idempotencyKey: "auth-owner-b"
      }
    });
    // Either hard reject (4xx/500 fail-closed) or non-hijacking 202 of the same operation.
    if (hijack.status === 202) {
      const body = hijack.body as { operationId?: string };
      expect(body.operationId).toBe(owner.operationId);
    } else {
      assertDenied(hijack, [400, 403, 409, 422, 500]);
    }
    expect(client.countServerRows("remote_execution_attempts")).toBe(1);

    await harness.acpControl.resume();
    const terminal = await client.waitForTerminal(owner.operationId);
    expect(terminal.state).toBe("completed");
  }, 120_000);
});
