import { ACTIVITY_RETENTION_MAX_AGE_MS } from "./limits.js";
import type { ActivityRepository } from "./activityRepository.js";

export const ACTIVITY_RETENTION_SWEEP_INTERVAL_MS = 3_600_000 as const;
export const ACTIVITY_RETENTION_SWEEP_LIMIT = 500 as const;

export class ActivityRetentionMaintenance {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private failure: unknown;

  constructor(
    private readonly activity: ActivityRepository,
    private readonly clock: () => Date = () => new Date(),
    private readonly intervalMs = ACTIVITY_RETENTION_SWEEP_INTERVAL_MS,
    private readonly limit = ACTIVITY_RETENTION_SWEEP_LIMIT
  ) {}

  async start(): Promise<void> {
    if (this.timer) return;
    await this.runSweep();
    this.timer = setInterval(() => {
      void this.runSweep().catch((error: unknown) => {
        this.failure = error;
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
    if (this.failure) throw this.failure;
  }

  private async runSweep(): Promise<void> {
    if (this.running) return this.running;
    this.running = Promise.resolve().then(() => {
      const cutoff = new Date(this.clock().getTime() - ACTIVITY_RETENTION_MAX_AGE_MS).toISOString();
      this.activity.purgeExpired(cutoff, this.limit);
    });
    try {
      await this.running;
    } catch (error) {
      this.failure = error;
      throw error;
    } finally {
      this.running = undefined;
    }
  }
}
