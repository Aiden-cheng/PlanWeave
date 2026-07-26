import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityRepository } from "../comments/activityRepository.js";
import { ActivityRetentionMaintenance } from "../comments/retention.js";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase } from "../sqlite.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("activity retention maintenance", () => {
  it("runs at startup and stops recurring sweeps before storage closes", async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(join(tmpdir(), "planweave-activity-retention-"));
    const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
    applyMigrations(database);
    const activity = new ActivityRepository(database);
    const purge = vi.spyOn(activity, "purgeExpired");
    const maintenance = new ActivityRetentionMaintenance(
      activity,
      () => new Date("2026-07-26T12:00:00.000Z"),
      1_000,
      10
    );

    try {
      await maintenance.start();
      expect(purge).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(purge).toHaveBeenCalledTimes(2);
      await maintenance.close();
      database.close();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(purge).toHaveBeenCalledTimes(2);
    } finally {
      try {
        database.close();
      } catch {
        // already closed
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
