import { describe, expect, it, vi } from "vitest";
import { RemoteCoordinationMaintenance } from "../remoteCoordinationMaintenance.js";

describe("RemoteCoordinationMaintenance", () => {
  it("reconciles periodically without overlapping and drains the active pass on close", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const reconcile = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const maintenance = new RemoteCoordinationMaintenance(reconcile, 1_000);

    maintenance.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reconcile).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(reconcile).toHaveBeenCalledTimes(1);

    const closing = maintenance.close();
    release?.();
    await closing;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reconcile).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("reports a failed reconciliation when closed", async () => {
    vi.useFakeTimers();
    const maintenance = new RemoteCoordinationMaintenance(async () => {
      throw new Error("reconcile failed");
    }, 1_000);

    maintenance.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(maintenance.close()).rejects.toThrow("reconcile failed");
    vi.useRealTimers();
  });
});
