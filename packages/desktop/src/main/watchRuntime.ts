export type WatchTask = () => void | Promise<void>;

export type WatchTimer = {
  cancel(): void;
};

export type WatchScheduler = {
  nowMs(): number;
  schedule(delayMs: number, task: WatchTask): WatchTimer;
  repeat(intervalMs: number, task: WatchTask): WatchTimer;
};

/** Serializes related watch work and invalidates queued or in-flight commits when closed. */
export class WatchTaskQueue {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  run(task: (isCurrent: () => boolean) => Promise<void>): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    const run = this.tail.then(async () => {
      if (this.closed) {
        return;
      }
      await task(() => !this.closed);
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  close(): void {
    this.closed = true;
  }
}

function runSystemTask(task: WatchTask): void {
  const result = task();
  if (result instanceof Promise) {
    void result.catch((error: unknown) => {
      queueMicrotask(() => {
        throw error;
      });
    });
  }
}

export const systemWatchScheduler: WatchScheduler = {
  nowMs: () => Date.now(),
  schedule(delayMs, task) {
    const timer = setTimeout(() => runSystemTask(task), delayMs);
    return {
      cancel: () => clearTimeout(timer)
    };
  },
  repeat(intervalMs, task) {
    const timer = setInterval(() => runSystemTask(task), intervalMs);
    return {
      cancel: () => clearInterval(timer)
    };
  }
};

export type PollingWatchLaneOptions = {
  scheduler: WatchScheduler;
  queue?: WatchTaskQueue;
  intervalMs: number;
  kickoffMs?: number;
  runImmediately?: boolean;
  backoffBaseMs: number;
  backoffMaxMs: number;
  run(isCurrent: () => boolean): Promise<void>;
  onError(error: unknown): void;
};

/** Owns timer cadence, single-flight execution, retry backoff, and close invalidation for one lane. */
export class PollingWatchLane {
  private readonly timers: WatchTimer[] = [];
  private inFlight: Promise<void> | null = null;
  private failureBackoffMs = 0;
  private nextAllowedAtMs = 0;
  private closed = false;
  private started = false;

  constructor(private readonly options: PollingWatchLaneOptions) {}

  start(): void {
    if (this.started || this.closed) {
      return;
    }
    this.started = true;
    if (this.options.runImmediately) {
      this.timers.push(this.options.scheduler.schedule(0, () => this.trigger()));
    }
    if (this.options.kickoffMs !== undefined) {
      this.timers.push(
        this.options.scheduler.schedule(this.options.kickoffMs, () => this.trigger())
      );
    }
    this.timers.push(this.options.scheduler.repeat(this.options.intervalMs, () => this.trigger()));
  }

  trigger(): Promise<void> {
    if (this.closed || this.options.scheduler.nowMs() < this.nextAllowedAtMs) {
      return Promise.resolve();
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    let run!: Promise<void>;
    run = (async () => {
      try {
        const runTask = (isQueueCurrent: () => boolean) =>
          this.options.run(() => !this.closed && isQueueCurrent());
        if (this.options.queue) {
          await this.options.queue.run(runTask);
        } else {
          await runTask(() => true);
        }
        if (!this.closed) {
          this.failureBackoffMs = 0;
          this.nextAllowedAtMs = 0;
        }
      } catch (error) {
        if (!this.closed) {
          this.failureBackoffMs =
            this.failureBackoffMs <= 0
              ? this.options.backoffBaseMs
              : Math.min(this.options.backoffMaxMs, this.failureBackoffMs * 2);
          this.nextAllowedAtMs = this.options.scheduler.nowMs() + this.failureBackoffMs;
          this.options.onError(error);
        }
      } finally {
        if (this.inFlight === run) {
          this.inFlight = null;
        }
      }
    })();
    this.inFlight = run;
    return run;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const timer of this.timers) {
      timer.cancel();
    }
    this.timers.length = 0;
  }
}
