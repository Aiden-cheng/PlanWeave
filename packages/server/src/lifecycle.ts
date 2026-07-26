import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ServerStorageConfig } from "./config.js";
import { applyMigrations, centralSchemaVersion } from "./migrations.js";
import {
  acquireServerInstanceOwnership,
  releaseServerInstanceOwnership
} from "./serverInstanceOwnership.js";
import { openServerDatabase, type SqliteDatabase } from "./sqlite.js";

export type StartupContext = {
  serverInstanceOwnerToken: string;
};

export type StartupReconciliationHook = (
  database: SqliteDatabase,
  context: StartupContext
) => void | Promise<void>;

export type PlanweaveServer = {
  config: ServerStorageConfig;
  database: SqliteDatabase;
  serverInstanceOwnerToken: string;
  readiness(): { status: "ready"; schemaVersion: number };
  backupPath(): string;
  createBackup(name: string): Promise<string>;
  close(): void;
};

export async function startPlanweaveServer(
  config: ServerStorageConfig,
  reconciliationHooks: readonly StartupReconciliationHook[] = []
): Promise<PlanweaveServer> {
  await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
  await chmod(config.dataDirectory, 0o700);

  const database = await openServerDatabase(config.databasePath, config.busyTimeoutMs);
  let serverInstanceOwnerToken: string | undefined;
  try {
    await chmod(config.databasePath, 0o600);
    applyMigrations(database);
    const ownership = acquireServerInstanceOwnership(database);
    serverInstanceOwnerToken = ownership.ownerToken;
    const acquiredOwnerToken = ownership.ownerToken;
    const startupContext = {
      serverInstanceOwnerToken: acquiredOwnerToken
    } satisfies StartupContext;
    for (const hook of reconciliationHooks) {
      await hook(database, startupContext);
    }
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

    return {
      config,
      database,
      serverInstanceOwnerToken: acquiredOwnerToken,
      readiness: () => ({ status: "ready", schemaVersion: centralSchemaVersion(database) }),
      backupPath,
      createBackup,
      close: () => {
        const activeAction = database
          .prepare(
            `SELECT 1 AS active FROM remote_execution_actions
             WHERE application_owner_token=? LIMIT 1`
          )
          .get(acquiredOwnerToken);
        if (activeAction) throw new Error("server_close_actions_in_progress");
        releaseServerInstanceOwnership(database, acquiredOwnerToken);
        database.close();
      }
    };
  } catch (error) {
    if (serverInstanceOwnerToken) {
      releaseServerInstanceOwnership(database, serverInstanceOwnerToken);
    }
    database.close();
    throw error;
  }
}
