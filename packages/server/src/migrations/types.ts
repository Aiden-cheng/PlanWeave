import type { SqliteDatabase } from "../sqlite.js";

export type Migration = {
  version: number;
  sql: string;
  disableForeignKeys?: boolean;
  before?: (database: SqliteDatabase) => void;
  after?: (database: SqliteDatabase) => void;
};

export type MigrationModule = {
  name: string;
  migrations: readonly Migration[];
};
