import type { SqliteDatabase } from "../sqlite.js";

export function tableExists(database: SqliteDatabase, table: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
  );
}

export function tableColumns(database: SqliteDatabase, table: string): ReadonlySet<string> {
  return new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
}

export function columnExists(database: SqliteDatabase, table: string, column: string): boolean {
  return tableColumns(database, table).has(column);
}
