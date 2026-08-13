import { describe, expect, it, vi } from "vitest";
import { createCollaborationHandlerLifecycle } from "../main/collaboration/collaborationHandlerLifecycle.js";

describe("collaboration handler lifecycle", () => {
  it("drains startup recovery and dependent IPC before allowing service disposal", async () => {
    const lifecycle = createCollaborationHandlerLifecycle();
    const events: string[] = [];
    let finishRecovery: (() => void) | undefined;
    const recovery = lifecycle.run(
      () =>
        new Promise<void>((resolve) => {
          events.push("recovery:start");
          finishRecovery = () => {
            events.push("recovery:end");
            resolve();
          };
        })
    );
    const statusRequest = lifecycle.run(async () => {
      await recovery;
      events.push("status:complete");
    });

    const drained = lifecycle.closeAndDrain().then(() => events.push("service:dispose"));
    await vi.waitFor(() => expect(events).toEqual(["recovery:start"]));
    expect(events).not.toContain("service:dispose");

    finishRecovery?.();
    await Promise.all([statusRequest, drained]);
    expect(events).toEqual([
      "recovery:start",
      "recovery:end",
      "status:complete",
      "service:dispose"
    ]);
  });

  it("rejects operations that start after shutdown begins", async () => {
    const lifecycle = createCollaborationHandlerLifecycle();
    await lifecycle.closeAndDrain();

    await expect(lifecycle.run(async () => undefined)).rejects.toThrow(
      "Collaboration handlers are shutting down."
    );
  });
});
