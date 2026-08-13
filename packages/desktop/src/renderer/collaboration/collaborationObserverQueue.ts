type QueueEntry<T> = {
  value: T;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export class CollaborationObserverQueue<T> {
  private readonly queue: QueueEntry<T>[] = [];
  private readonly queuedKeys = new Set<number>();
  private activeCount = 0;

  constructor(
    private readonly options: {
      concurrency: number;
      queueLimit: number;
      key(value: T): number;
      isCurrent(value: T): boolean;
      execute(value: T): Promise<void>;
    }
  ) {}

  hasQueued(key: number): boolean {
    return this.queuedKeys.has(key);
  }

  enqueue(value: T): Promise<void> | null {
    if (this.queue.length >= this.options.queueLimit) return null;
    const key = this.options.key(value);
    this.queuedKeys.add(key);
    const queued = new Promise<void>((resolve, reject) => {
      this.queue.push({ value, resolve, reject });
    });
    this.pump();
    return queued;
  }

  cancelQueued(): void {
    for (const entry of this.queue.splice(0)) {
      entry.resolve();
    }
    this.queuedKeys.clear();
  }

  private pump(): void {
    while (this.activeCount < this.options.concurrency && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) return;
      this.queuedKeys.delete(this.options.key(entry.value));
      if (!this.options.isCurrent(entry.value)) {
        entry.resolve();
        continue;
      }
      this.activeCount += 1;
      void this.options
        .execute(entry.value)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.activeCount -= 1;
          this.pump();
        });
    }
  }
}
