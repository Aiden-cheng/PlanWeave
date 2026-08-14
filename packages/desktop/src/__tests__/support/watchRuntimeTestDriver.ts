import type { WatchScheduler, WatchTask, WatchTimer } from "../../main/watchRuntime.js";

type ScheduledTask = {
  id: number;
  atMs: number;
  intervalMs: number | null;
  task: WatchTask;
};

/** Deterministic scheduler that advances timer callbacks separately from awaiting async I/O. */
export class WatchRuntimeTestDriver implements WatchScheduler {
  private readonly timers = new Map<number, ScheduledTask>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly failures: unknown[] = [];
  private currentTimeMs = Date.parse("2026-01-01T00:00:00.000Z");
  private nextId = 1;

  nowMs(): number {
    return this.currentTimeMs;
  }

  schedule(delayMs: number, task: WatchTask): WatchTimer {
    return this.addTimer(delayMs, null, task);
  }

  repeat(intervalMs: number, task: WatchTask): WatchTimer {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error("watch_test_interval_invalid");
    }
    return this.addTimer(intervalMs, intervalMs, task);
  }

  advanceBy(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error("watch_test_advance_invalid");
    }
    const targetTimeMs = this.currentTimeMs + milliseconds;
    let callbacks = 0;
    while (true) {
      const next = this.nextTimer();
      if (!next || next.atMs > targetTimeMs) {
        break;
      }
      callbacks += 1;
      if (callbacks > 100_000) {
        throw new Error("watch_test_scheduler_runaway");
      }
      this.currentTimeMs = next.atMs;
      if (next.intervalMs === null) {
        this.timers.delete(next.id);
      } else {
        next.atMs += next.intervalMs;
      }
      this.startTask(next.task);
    }
    this.currentTimeMs = targetTimeMs;
  }

  async advanceByAndDrain(milliseconds: number): Promise<void> {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error("watch_test_advance_invalid");
    }
    const targetTimeMs = this.currentTimeMs + milliseconds;
    while (true) {
      const next = this.nextTimer();
      if (!next || next.atMs > targetTimeMs) {
        break;
      }
      this.advanceBy(next.atMs - this.currentTimeMs);
      await this.drain();
    }
    this.currentTimeMs = targetTimeMs;
    await this.drain();
  }

  async drain(): Promise<void> {
    let passes = 0;
    while (true) {
      this.advanceBy(0);
      if (this.inFlight.size === 0) {
        break;
      }
      passes += 1;
      if (passes > 10_000) {
        throw new Error("watch_test_drain_runaway");
      }
      await Promise.allSettled([...this.inFlight]);
    }
    if (this.failures.length > 0) {
      throw this.failures.shift();
    }
  }

  pendingTimerCount(): number {
    return this.timers.size;
  }

  nextDelay(): number | undefined {
    const next = this.nextTimer();
    return next ? Math.max(0, next.atMs - this.currentTimeMs) : undefined;
  }

  reset(): void {
    if (this.inFlight.size > 0) {
      throw new Error("watch_test_reset_with_in_flight_tasks");
    }
    this.timers.clear();
    this.failures.length = 0;
    this.currentTimeMs = Date.parse("2026-01-01T00:00:00.000Z");
    this.nextId = 1;
  }

  private addTimer(delayMs: number, intervalMs: number | null, task: WatchTask): WatchTimer {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
      throw new Error("watch_test_delay_invalid");
    }
    const id = this.nextId++;
    this.timers.set(id, {
      id,
      atMs: this.currentTimeMs + delayMs,
      intervalMs,
      task
    });
    return {
      cancel: () => {
        this.timers.delete(id);
      }
    };
  }

  private startTask(task: WatchTask): void {
    let result: void | Promise<void>;
    try {
      result = task();
    } catch (error) {
      this.failures.push(error);
      return;
    }
    if (!(result instanceof Promise)) {
      return;
    }
    const tracked = result
      .catch((error: unknown) => {
        this.failures.push(error);
      })
      .finally(() => {
        this.inFlight.delete(tracked);
      });
    this.inFlight.add(tracked);
  }

  private nextTimer(): ScheduledTask | undefined {
    return [...this.timers.values()].sort(
      (left, right) => left.atMs - right.atMs || left.id - right.id
    )[0];
  }
}
