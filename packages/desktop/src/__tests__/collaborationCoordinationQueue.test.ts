import { describe, expect, it, vi } from "vitest";
import { createCollaborationCoordinationQueue } from "../main/collaboration/collaborationCoordinationQueue.js";

describe("collaboration coordination queue", () => {
  it("serializes authority mutations and continues after a rejected operation", async () => {
    const run = createCollaborationCoordinationQueue();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = run(
      () =>
        new Promise<void>((resolve) => {
          events.push("first:start");
          releaseFirst = () => {
            events.push("first:end");
            resolve();
          };
        })
    );
    const secondOperation = vi.fn(async () => {
      events.push("second:start");
      throw new Error("second_failed");
    });
    const thirdOperation = vi.fn(async () => {
      events.push("third:start");
      return "done";
    });
    const second = run(secondOperation);
    const third = run(thirdOperation);

    await vi.waitFor(() => expect(events).toEqual(["first:start"]));
    expect(secondOperation).not.toHaveBeenCalled();
    releaseFirst?.();
    await first;
    await expect(second).rejects.toThrow("second_failed");
    await expect(third).resolves.toBe("done");
    expect(events).toEqual(["first:start", "first:end", "second:start", "third:start"]);
  });
});
