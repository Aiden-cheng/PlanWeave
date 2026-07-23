import type { HostTransportClock } from "../../transport/hostTransport.js";

type ScheduledCallback = {
  readonly id: number;
  readonly at: number;
  readonly callback: () => void;
};

export class FakeHostTransportClock implements HostTransportClock {
  private readonly timers = new Map<number, ScheduledCallback>();
  private currentTime: number;
  private nextId = 1;

  constructor(now = new Date("2026-07-23T08:00:00.000Z")) {
    this.currentTime = now.getTime();
  }

  now(): Date {
    return new Date(this.currentTime);
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timers.set(id, { id, at: this.currentTime + delayMs, callback });
    return id;
  }

  clearTimeout(timer: unknown): void {
    if (typeof timer === "number") this.timers.delete(timer);
  }

  pendingTimerCount(): number {
    return this.timers.size;
  }

  nextDelay(): number | undefined {
    const next = this.nextTimer();
    return next ? Math.max(0, next.at - this.currentTime) : undefined;
  }

  advanceBy(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error("fake_host_transport_clock_advance_invalid");
    }
    const target = this.currentTime + milliseconds;
    let callbacks = 0;
    while (true) {
      const next = this.nextTimer();
      if (!next || next.at > target) break;
      this.currentTime = next.at;
      this.timers.delete(next.id);
      next.callback();
      callbacks += 1;
      if (callbacks > 10_000) throw new Error("fake_host_transport_clock_runaway");
    }
    this.currentTime = target;
  }

  private nextTimer(): ScheduledCallback | undefined {
    return [...this.timers.values()].sort(
      (left, right) => left.at - right.at || left.id - right.id
    )[0];
  }
}
