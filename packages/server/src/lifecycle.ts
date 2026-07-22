import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ServerConfig } from "./config.js";
import { applyMigrations, centralSchemaVersion } from "./migrations.js";
import { openServerDatabase, type SqliteDatabase } from "./sqlite.js";

export type StartupReconciliationHook = (database: SqliteDatabase) => void | Promise<void>;

export type PlanweaveServer = {
  config: ServerConfig;
  database: SqliteDatabase;
  readiness(): { status: "ready"; schemaVersion: number };
  backupPath(): string;
  createBackup(name: string): Promise<string>;
  close(): void;
};

export async function startPlanweaveServer(
  config: ServerConfig,
  reconciliationHooks: readonly StartupReconciliationHook[] = []
): Promise<PlanweaveServer> {
  await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
  await chmod(config.dataDirectory, 0o700);

  const database = await openServerDatabase(config.databasePath, config.busyTimeoutMs);
  await chmod(config.databasePath, 0o600);

  applyMigrations(database);

  const backupPath = () => join(config.dataDirectory, "backups");
  const createBackup = async (name: string): Promise<string> => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
      throw new Error("Backup name must be a safe filename.");
    }
    const directory = backupPath();
    await mkdir(directory, { recursive: true });
    const target = join(directory, name);
    database.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
    return target;
  };

  for (const hook of reconciliationHooks) {
    await hook(database);
  }

  return {
    config,
    database,
    readiness: () => ({ status: "ready", schemaVersion: centralSchemaVersion(database) }),
    backupPath,
    createBackup,
    close: () => {
      database.close();
    }
  };
}
