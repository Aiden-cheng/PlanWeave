import { describe, expect, it } from "vitest";
import {
  CollaborationEventCursorWindow,
  CollaborationMutationLedger
} from "../renderer/collaboration/collaborationRetention.js";
import type { CollaborationMutationRecord } from "../shared/collaborationReadModels.js";

function mutation(mutationId: string, status: CollaborationMutationRecord["status"]) {
  return {
    mutationId,
    kind: "assignment" as const,
    workItemKey: "block:canvas-1:T-1#B-1",
    status,
    submittedAt: "2030-01-01T00:00:00.000Z",
    ...(status === "pending" ? {} : { resolvedAt: "2030-01-01T00:00:01.000Z" })
  };
}

describe("CollaborationEventCursorWindow", () => {
  it("bounds applied and failed cursor history until an authoritative refresh retires it", () => {
    const window = new CollaborationEventCursorWindow();
    for (let cursor = 1; cursor <= 512; cursor += 1) {
      window.markApplied(cursor);
    }
    expect(window.requiresRefresh()).toBe(true);
    expect(window.hasApplied(1)).toBe(true);

    const beforeOverflow = window.version();
    window.markApplied(513);
    expect(window.hasApplied(513)).toBe(false);
    expect(window.retireAfterRefresh(beforeOverflow)).toBe(false);
    expect(window.requiresRefresh()).toBe(true);
    expect(window.retireAfterRefresh(window.version())).toBe(true);
    expect(window.hasApplied(1)).toBe(false);

    for (let cursor = 1; cursor <= 129; cursor += 1) {
      window.markFailed(cursor);
    }
    expect(window.isFailed(1)).toBe(true);
    expect(window.isFailed(128)).toBe(true);
    expect(window.isFailed(129)).toBe(false);
    expect(window.requiresRefresh()).toBe(true);
    expect(window.retireAfterRefresh(window.version())).toBe(true);
    expect(window.isFailed(1)).toBe(false);
  });

  it("dedupes only while an invalidation request owns the latest attempt token", () => {
    const window = new CollaborationEventCursorWindow();
    window.begin(42, 1);
    expect(window.isInFlight(42)).toBe(true);
    window.begin(42, 2);
    window.finish(42, 1);
    expect(window.isInFlight(42)).toBe(true);
    window.finish(42, 2);
    expect(window.isInFlight(42)).toBe(false);
  });
});

describe("CollaborationMutationLedger", () => {
  it("keeps all pending mutations and bounds terminal records by completion order", () => {
    const ledger = new CollaborationMutationLedger();
    for (let index = 1; index <= 257; index += 1) {
      ledger.setPending(mutation(`mut-${index}`, "pending"));
    }
    expect(ledger.records.size).toBe(257);

    for (let index = 2; index <= 257; index += 1) {
      ledger.setTerminal(mutation(`mut-${index}`, "confirmed"));
    }
    expect(ledger.records.get("mut-1")?.status).toBe("pending");

    ledger.setTerminal(mutation("mut-1", "confirmed"));
    expect(ledger.records.size).toBe(256);
    expect(ledger.records.get("mut-1")?.status).toBe("confirmed");
    expect(ledger.records.has("mut-2")).toBe(false);
    expect(ledger.records.get("mut-257")?.status).toBe("confirmed");
  });
});
