import { describe, expect, it, vi } from "vitest";
import { PollingWatchLane, WatchTaskQueue } from "../main/watchRuntime.js";
import { WatchRuntimeTestDriver } from "./support/watchRuntimeTestDriver.js";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("watch runtime", () => {
  it("settles async work at its scheduled logical time before advancing later timers", async () => {
    const scheduler = new WatchRuntimeTestDriver();
    const events: string[] = [];

    scheduler.schedule(100, async () => {
      events.push("first");
      await Promise.resolve();
      scheduler.schedule(50, () => events.push("second"));
    });

    await scheduler.advanceByAndDrain(149);
    expect(events).toEqual(["first"]);
    expect(scheduler.nextDelay()).toBe(1);

    await scheduler.advanceByAndDrain(1);
    expect(events).toEqual(["first", "second"]);
  });

  it("keeps a lane single-flight and invalidates delayed completion after close", async () => {
    const scheduler = new WatchRuntimeTestDriver();
    const heldRun = createDeferred<void>();
    const commits: string[] = [];
    const run = vi.fn(async (isCurrent: () => boolean) => {
      await heldRun.promise;
      if (isCurrent()) {
        commits.push("committed");
      }
    });
    const lane = new PollingWatchLane({
      scheduler,
      intervalMs: 100,
      runImmediately: true,
      backoffBaseMs: 100,
      backoffMaxMs: 400,
      run,
      onError: vi.fn()
    });

    lane.start();
    scheduler.advanceBy(500);
    expect(run).toHaveBeenCalledTimes(1);

    lane.close();
    heldRun.resolve();
    await scheduler.drain();

    expect(commits).toEqual([]);
    expect(scheduler.pendingTimerCount()).toBe(0);
  });

  it("serializes related lanes through one queue", async () => {
    const scheduler = new WatchRuntimeTestDriver();
    const queue = new WatchTaskQueue();
    const firstRun = createDeferred<void>();
    const events: string[] = [];
    const firstLane = new PollingWatchLane({
      scheduler,
      queue,
      intervalMs: 100,
      runImmediately: true,
      backoffBaseMs: 100,
      backoffMaxMs: 400,
      run: async () => {
        events.push("first:start");
        await firstRun.promise;
        events.push("first:end");
      },
      onError: vi.fn()
    });
    const secondLane = new PollingWatchLane({
      scheduler,
      queue,
      intervalMs: 100,
      runImmediately: true,
      backoffBaseMs: 100,
      backoffMaxMs: 400,
      run: async () => {
        events.push("second");
      },
      onError: vi.fn()
    });

    firstLane.start();
    secondLane.start();
    scheduler.advanceBy(0);
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    firstRun.resolve();
    await scheduler.drain();
    expect(events).toEqual(["first:start", "first:end", "second"]);

    firstLane.close();
    secondLane.close();
    queue.close();
  });

  it("applies bounded retry backoff and resets it after recovery", async () => {
    const scheduler = new WatchRuntimeTestDriver();
    const onError = vi.fn();
    let healthy = false;
    const run = vi.fn(async () => {
      if (!healthy) {
        throw new Error("probe failed");
      }
    });
    const lane = new PollingWatchLane({
      scheduler,
      intervalMs: 100,
      backoffBaseMs: 100,
      backoffMaxMs: 400,
      run,
      onError
    });

    lane.start();
    await scheduler.advanceByAndDrain(100);
    await scheduler.advanceByAndDrain(100);
    await scheduler.advanceByAndDrain(100);
    expect(run).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);

    healthy = true;
    await scheduler.advanceByAndDrain(100);
    expect(run).toHaveBeenCalledTimes(3);

    healthy = false;
    await scheduler.advanceByAndDrain(100);
    expect(run).toHaveBeenCalledTimes(4);
    expect(onError).toHaveBeenCalledTimes(3);
  });
});
