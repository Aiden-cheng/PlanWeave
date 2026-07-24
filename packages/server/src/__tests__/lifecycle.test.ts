import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startPlanweaveServer } from "../lifecycle.js";
import { latestCentralSchemaVersion } from "../migrations.js";
import { openServerDatabase } from "../sqlite.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("server lifecycle", () => {
  it("opens a migrated database, runs reconciliation, and creates a backup", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-server-"));
    directories.push(dataDirectory);
    let reconciled = false;
    const server = await startPlanweaveServer(
      { dataDirectory, databasePath: join(dataDirectory, "server.sqlite"), busyTimeoutMs: 5000 },
      [
        () => {
          reconciled = true;
        }
      ]
    );

    try {
      expect(server.readiness()).toEqual({ status: "ready", schemaVersion: 16 });
      expect(reconciled).toBe(true);
      const backup = await server.createBackup("before-upgrade.sqlite");
      expect((await stat(backup)).size).toBeGreaterThan(0);
      expect((await readFile(backup)).subarray(0, 16).toString("utf8")).toBe(
        "SQLite format 3\u0000"
      );
    } finally {
      server.close();
    }
  });

  it("rejects unsafe backup names", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-server-backup-"));
    directories.push(dataDirectory);
    const server = await startPlanweaveServer({
      dataDirectory,
      databasePath: join(dataDirectory, "server.sqlite"),
      busyTimeoutMs: 5000
    });

    try {
      await expect(server.createBackup("../outside.sqlite")).rejects.toThrowError(
        "Backup name must be a safe filename."
      );
    } finally {
      server.close();
    }
  });

  it("rejects a future schema version and releases the database", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-server-future-"));
    directories.push(dataDirectory);
    const databasePath = join(dataDirectory, "server.sqlite");
    const initialized = await startPlanweaveServer({
      dataDirectory,
      databasePath,
      busyTimeoutMs: 5_000
    });
    initialized.close();

    const future = await openServerDatabase(databasePath, 5_000);
    future
      .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(latestCentralSchemaVersion + 1, new Date().toISOString());
    future.close();

    await expect(
      startPlanweaveServer({ dataDirectory, databasePath, busyTimeoutMs: 5_000 })
    ).rejects.toThrow("server_schema_version_unsupported");
    const reopened = await openServerDatabase(databasePath, 5_000);
    reopened.close();
  });
});
