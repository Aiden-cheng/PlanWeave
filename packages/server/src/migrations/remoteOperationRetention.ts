import type { Migration } from "./types.js";
import type { SqliteDatabase } from "../sqlite.js";

const receiptColumns = [
  ["operation_id", "TEXT", 0, 1],
  ["workspace_id", "TEXT", 1, 0],
  ["project_id", "TEXT", 1, 0],
  ["canvas_id", "TEXT", 1, 0],
  ["terminal_state", "TEXT", 1, 0],
  ["terminal_at", "TEXT", 1, 0],
  ["execution_attempt_id", "TEXT", 1, 0],
  ["dispatch_id", "TEXT", 1, 0],
  ["receipt_digest", "TEXT", 1, 0],
  ["summary_json", "TEXT", 1, 0],
  ["compacted_at", "TEXT", 1, 0]
] as const;

const receiptTableDdl = `
  CREATE TABLE IF NOT EXISTS remote_operation_retention_receipts (
    operation_id TEXT PRIMARY KEY REFERENCES remote_operations(id),
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    canvas_id TEXT NOT NULL,
    terminal_state TEXT NOT NULL CHECK(terminal_state IN ('completed','failed','cancelled')),
    terminal_at TEXT NOT NULL,
    execution_attempt_id TEXT NOT NULL,
    dispatch_id TEXT NOT NULL,
    receipt_digest TEXT NOT NULL CHECK(
      length(receipt_digest)=64 AND receipt_digest NOT GLOB '*[^a-f0-9]*'
    ),
    summary_json TEXT NOT NULL CHECK(json_valid(summary_json)),
    compacted_at TEXT NOT NULL
  )
`;

const scopeIndexDdl = `
  CREATE INDEX IF NOT EXISTS idx_remote_operation_retention_scope_terminal
    ON remote_operations(workspace_id,project_id,canvas_id,terminal_at DESC,id DESC)
    WHERE state IN ('completed','failed','cancelled')
`;

type SqlToken = { kind: "identifier" | "literal" | "symbol"; value: string };

function canonicalSql(value: string): string {
  const tokens: SqlToken[] = [];
  for (let index = 0; index < value.length; ) {
    const character = value[index]!;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "'") {
      let literal = character;
      index += 1;
      while (index < value.length) {
        const next = value[index]!;
        literal += next;
        index += 1;
        if (next === "'" && value[index] === "'") {
          literal += value[index];
          index += 1;
        } else if (next === "'") {
          break;
        }
      }
      tokens.push({ kind: "literal", value: literal });
      continue;
    }
    if (character === '"' || character === "`" || character === "[") {
      const closing = character === "[" ? "]" : character;
      let identifier = "";
      index += 1;
      while (index < value.length && value[index] !== closing) {
        identifier += value[index];
        index += 1;
      }
      index += 1;
      tokens.push({ kind: "identifier", value: identifier.toLowerCase() });
      continue;
    }
    const identifier = value.slice(index).match(/^[a-z_][a-z0-9_]*/i)?.[0];
    if (identifier) {
      tokens.push({ kind: "identifier", value: identifier.toLowerCase() });
      index += identifier.length;
      continue;
    }
    const operator = value.slice(index).match(/^(?:<>|<=|>=|!=)/)?.[0];
    if (operator) {
      tokens.push({ kind: "symbol", value: operator });
      index += operator.length;
      continue;
    }
    tokens.push({ kind: "symbol", value: character });
    index += 1;
  }
  if (tokens.at(-1)?.value === ";") tokens.pop();
  const objectTypeIndex =
    tokens[1]?.value === "table" || tokens[1]?.value === "index"
      ? 1
      : tokens[1]?.value === "unique" && tokens[2]?.value === "index"
        ? 2
        : -1;
  if (
    objectTypeIndex >= 0 &&
    tokens[objectTypeIndex + 1]?.value === "if" &&
    tokens[objectTypeIndex + 2]?.value === "not" &&
    tokens[objectTypeIndex + 3]?.value === "exists"
  ) {
    tokens.splice(objectTypeIndex + 1, 3);
  }
  return tokens.map((token) => `${token.kind}:${token.value}`).join("|");
}

export function validateRemoteOperationRetentionSchema(database: SqliteDatabase): void {
  const columns = database.prepare("PRAGMA table_info(remote_operation_retention_receipts)").all();
  if (
    columns.length !== receiptColumns.length ||
    columns.some((column, index) => {
      const expected = receiptColumns[index];
      return (
        column.name !== expected?.[0] ||
        column.type !== expected[1] ||
        column.notnull !== expected[2] ||
        column.pk !== expected[3]
      );
    })
  ) {
    throw new Error("remote_operation_retention_schema_invalid:receipt_columns");
  }
  const foreignKeys = database
    .prepare("PRAGMA foreign_key_list(remote_operation_retention_receipts)")
    .all();
  if (
    foreignKeys.length !== 1 ||
    foreignKeys[0]?.id !== 0 ||
    foreignKeys[0]?.seq !== 0 ||
    foreignKeys[0]?.table !== "remote_operations" ||
    foreignKeys[0]?.from !== "operation_id" ||
    foreignKeys[0]?.to !== "id" ||
    foreignKeys[0]?.on_update !== "NO ACTION" ||
    foreignKeys[0]?.on_delete !== "NO ACTION" ||
    foreignKeys[0]?.match !== "NONE"
  ) {
    throw new Error("remote_operation_retention_schema_invalid:receipt_foreign_key");
  }
  const table = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='remote_operation_retention_receipts'"
    )
    .get();
  if (typeof table?.sql !== "string") {
    throw new Error("remote_operation_retention_schema_invalid:receipt_table");
  }
  if (canonicalSql(table.sql) !== canonicalSql(receiptTableDdl)) {
    throw new Error("remote_operation_retention_schema_invalid:receipt_definition");
  }
  const index = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_remote_operation_retention_scope_terminal'"
    )
    .get();
  const indexColumns = database
    .prepare("PRAGMA index_info(idx_remote_operation_retention_scope_terminal)")
    .all()
    .map((column) => column.name);
  const indexList = database
    .prepare("PRAGMA index_list(remote_operations)")
    .all()
    .filter((candidate) => candidate.name === "idx_remote_operation_retention_scope_terminal");
  const indexSql = typeof index?.sql === "string" ? canonicalSql(index.sql) : "";
  if (
    indexList.length !== 1 ||
    indexList[0]?.unique !== 0 ||
    indexList[0]?.origin !== "c" ||
    indexList[0]?.partial !== 1 ||
    indexColumns.join(",") !== "workspace_id,project_id,canvas_id,terminal_at,id" ||
    indexSql !== canonicalSql(scopeIndexDdl)
  ) {
    throw new Error("remote_operation_retention_schema_invalid:scope_index");
  }
}

export const remoteOperationRetentionMigration: Migration = {
  version: 49,
  sql: `${receiptTableDdl};${scopeIndexDdl};`,
  after: validateRemoteOperationRetentionSchema
};
