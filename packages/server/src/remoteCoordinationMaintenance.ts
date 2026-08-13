export class RemoteCoordinationMaintenance {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private failure: unknown;

  constructor(
    private readonly reconcile: () => Promise<unknown>,
    private readonly intervalMs: number,
    private readonly maintain?: () => void
  ) {}

  start(): void {
    if (this.timer) return;
    this.maintain?.();
    this.timer = setInterval(() => {
      void this.run().catch((error: unknown) => {
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

  private async run(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.reconcile().then(() => {
      this.maintain?.();
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
