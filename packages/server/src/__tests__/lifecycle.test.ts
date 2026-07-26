import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startPlanweaveServer } from "../lifecycle.js";
import { latestCentralSchemaVersion } from "../migrations.js";
import { openServerDatabase } from "../sqlite.js";
import { releaseServerInstanceOwnership } from "../serverInstanceOwnership.js";

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
        (database, context) => {
          expect(
            database
              .prepare("SELECT owner_token FROM server_instance_ownership WHERE singleton=1")
              .get()?.owner_token
          ).toBe(context.serverInstanceOwnerToken);
          reconciled = true;
        }
      ]
    );

    try {
      expect(server.readiness()).toEqual({
        status: "ready",
        schemaVersion: latestCentralSchemaVersion
      });
      expect(reconciled).toBe(true);
      // Public schema: portable envelope identity; no residual package_ref column on fresh DBs.
      expect(
        server.database
          .prepare("PRAGMA table_info(dispatches)")
          .all()
          .some((row) => row.name === "package_ref")
      ).toBe(false);
      const backup = await server.createBackup("before-upgrade.sqlite");
      expect((await stat(backup)).size).toBeGreaterThan(0);
      expect((await readFile(backup)).subarray(0, 16).toString("utf8")).toBe(
        "SQLite format 3\u0000"
      );
    } finally {
      server.close();
    }
  });

  it("fails closed while the same database is owned by a live process", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-server-active-owner-"));
    directories.push(dataDirectory);
    const config = {
      dataDirectory,
      databasePath: join(dataDirectory, "server.sqlite"),
      busyTimeoutMs: 5_000
    };
    const active = await startPlanweaveServer(config);
    try {
      await expect(startPlanweaveServer(config)).rejects.toThrow("server_database_already_active");
    } finally {
      active.close();
    }
  });

  it("does not release ownership while an action application is still claimed", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-server-active-action-"));
    directories.push(dataDirectory);
    const config = {
      dataDirectory,
      databasePath: join(dataDirectory, "server.sqlite"),
      busyTimeoutMs: 5_000
    };
    const active = await startPlanweaveServer(config);
    active.database.exec("PRAGMA foreign_keys=OFF");
    active.database
      .prepare(
        `INSERT INTO remote_execution_actions(
           action_id,operation_id,dispatch_id,execution_attempt_id,kind,
           request_fingerprint,request_json,state,created_at,
           application_owner_token,application_claimed_at
         ) VALUES (?,?,?,?,?,?,?,'recorded',?,?,?)`
      )
      .run(
        "active-action",
        "missing-operation",
        "missing-dispatch",
        "missing-attempt",
        "cancel",
        "0".repeat(64),
        "{}",
        "2030-01-01T00:00:00.000Z",
        active.serverInstanceOwnerToken,
        "2030-01-01T00:00:00.000Z"
      );
    active.database.exec("PRAGMA foreign_keys=ON");

    expect(() => active.close()).toThrow("server_close_actions_in_progress");
    await expect(startPlanweaveServer(config)).rejects.toThrow("server_database_already_active");
    active.database
      .prepare(
        `UPDATE remote_execution_actions
         SET application_owner_token=NULL,application_claimed_at=NULL
         WHERE action_id='active-action'`
      )
      .run();
    active.close();
  });

  it("atomically admits only one concurrent server instance", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-server-concurrent-owner-"));
    directories.push(dataDirectory);
    const config = {
      dataDirectory,
      databasePath: join(dataDirectory, "server.sqlite"),
      busyTimeoutMs: 5_000
    };
    const attempts = await Promise.allSettled([
      startPlanweaveServer(config),
      startPlanweaveServer(config)
    ]);
    const fulfilled = attempts.filter(
      (
        attempt
      ): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof startPlanweaveServer>>> =>
        attempt.status === "fulfilled"
    );
    expect(fulfilled).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    fulfilled[0]?.value.close();
  });

  it("takes over a stale same-host owner and only deletes its own ownership row", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-server-stale-owner-"));
    directories.push(dataDirectory);
    const config = {
      dataDirectory,
      databasePath: join(dataDirectory, "server.sqlite"),
      busyTimeoutMs: 5_000
    };
    const initialized = await startPlanweaveServer(config);
    initialized.close();
    const seeded = await openServerDatabase(config.databasePath, config.busyTimeoutMs);
    seeded
      .prepare(
        `INSERT INTO server_instance_ownership(
           singleton,owner_token,process_id,hostname,acquired_at
         ) VALUES (1,?,2147483647,?,?)`
      )
      .run("00000000-0000-4000-8000-000000000001", hostname(), "2030-01-01T00:00:00.000Z");
    expect(() =>
      releaseServerInstanceOwnership(seeded, "00000000-0000-4000-8000-000000000002")
    ).toThrow("server_instance_ownership_lost");
    expect(
      seeded.prepare("SELECT owner_token FROM server_instance_ownership").get()?.owner_token
    ).toBe("00000000-0000-4000-8000-000000000001");
    seeded.close();

    const takeover = await startPlanweaveServer(config);
    try {
      expect(takeover.serverInstanceOwnerToken).not.toBe("00000000-0000-4000-8000-000000000001");
    } finally {
      takeover.close();
    }
  });

  it("fails closed when an ownership row belongs to another host", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-server-remote-owner-"));
    directories.push(dataDirectory);
    const config = {
      dataDirectory,
      databasePath: join(dataDirectory, "server.sqlite"),
      busyTimeoutMs: 5_000
    };
    const initialized = await startPlanweaveServer(config);
    initialized.close();
    const seeded = await openServerDatabase(config.databasePath, config.busyTimeoutMs);
    seeded
      .prepare(
        `INSERT INTO server_instance_ownership(
           singleton,owner_token,process_id,hostname,acquired_at
         ) VALUES (1,?,?,?,?)`
      )
      .run(
        "00000000-0000-4000-8000-000000000003",
        process.pid,
        "different-host.example",
        "2030-01-01T00:00:00.000Z"
      );
    seeded.close();

    await expect(startPlanweaveServer(config)).rejects.toThrow(
      "server_database_owned_by_remote_host"
    );
    const cleanup = await openServerDatabase(config.databasePath, config.busyTimeoutMs);
    cleanup.prepare("DELETE FROM server_instance_ownership").run();
    cleanup.close();
  });

  it("releases only its ownership when a startup hook fails", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-server-hook-failure-"));
    directories.push(dataDirectory);
    const config = {
      dataDirectory,
      databasePath: join(dataDirectory, "server.sqlite"),
      busyTimeoutMs: 5_000
    };
    await expect(
      startPlanweaveServer(config, [() => Promise.reject(new Error("reconciliation_failed"))])
    ).rejects.toThrow("reconciliation_failed");
    const restarted = await startPlanweaveServer(config);
    restarted.close();
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

  it("drops residual dispatches.package_ref on upgrade and never reintroduces it", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-server-package-ref-"));
    directories.push(dataDirectory);
    const databasePath = join(dataDirectory, "server.sqlite");
    const initialized = await startPlanweaveServer({
      dataDirectory,
      databasePath,
      busyTimeoutMs: 5_000
    });
    initialized.close();

    const rolledBack = await openServerDatabase(databasePath, 5_000);
    rolledBack.prepare("DELETE FROM schema_migrations WHERE version>=?").run(21);
    // Reintroduce historical column as a v20 residual for upgrade coverage.
    const columns = rolledBack.prepare("PRAGMA table_info(dispatches)").all();
    if (!columns.some((row) => row.name === "package_ref")) {
      rolledBack.exec("ALTER TABLE dispatches ADD COLUMN package_ref TEXT NOT NULL DEFAULT ''");
    }
    expect(
      rolledBack
        .prepare("PRAGMA table_info(dispatches)")
        .all()
        .some((row) => row.name === "package_ref")
    ).toBe(true);
    rolledBack.close();

    const upgraded = await startPlanweaveServer({
      dataDirectory,
      databasePath,
      busyTimeoutMs: 5_000
    });
    try {
      expect(upgraded.readiness().schemaVersion).toBe(latestCentralSchemaVersion);
      expect(
        upgraded.database
          .prepare("PRAGMA table_info(dispatches)")
          .all()
          .some((row) => row.name === "package_ref")
      ).toBe(false);
    } finally {
      upgraded.close();
    }
  });
});
