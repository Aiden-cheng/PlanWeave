import type { SqliteDatabase } from "../sqlite.js";
import type { Migration } from "./types.js";

const scopedObserverEventsSql = `
ALTER TABLE human_observer_events RENAME TO human_observer_events_legacy_v26;

CREATE TABLE human_observer_events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  previous_cursor INTEGER NOT NULL CHECK(previous_cursor >= 0),
  event_json TEXT NOT NULL CHECK(json_valid(event_json)),
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_human_observer_workspace_project_cursor
  ON human_observer_events(workspace_id,project_id,cursor);

CREATE TABLE human_observer_events_unscoped_legacy (
  cursor INTEGER PRIMARY KEY,
  project_id TEXT NOT NULL,
  previous_cursor INTEGER NOT NULL CHECK(previous_cursor >= 0),
  event_json TEXT NOT NULL CHECK(json_valid(event_json)),
  occurred_at TEXT NOT NULL,
  quarantined_at TEXT NOT NULL
);
`;

function observerColumns(database: SqliteDatabase): Set<string> {
  return new Set(
    (
      database.prepare("PRAGMA table_info(human_observer_events)").all() as Array<{ name: string }>
    ).map((column) => column.name)
  );
}

function migrateScopedObserverEvents(database: SqliteDatabase): void {
  if (observerColumns(database).has("workspace_id")) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_human_observer_workspace_project_cursor
        ON human_observer_events(workspace_id,project_id,cursor);
      CREATE TABLE IF NOT EXISTS human_observer_events_unscoped_legacy (
        cursor INTEGER PRIMARY KEY,
        project_id TEXT NOT NULL,
        previous_cursor INTEGER NOT NULL CHECK(previous_cursor >= 0),
        event_json TEXT NOT NULL CHECK(json_valid(event_json)),
        occurred_at TEXT NOT NULL,
        quarantined_at TEXT NOT NULL
      );
    `);
    return;
  }
  const at = new Date().toISOString();
  database.exec(scopedObserverEventsSql);
  database
    .prepare(
      `INSERT INTO human_observer_events(
        cursor,workspace_id,project_id,previous_cursor,event_json,occurred_at
      )
      SELECT legacy.cursor,scopes.workspace_id,legacy.project_id,
             legacy.previous_cursor,legacy.event_json,legacy.occurred_at
      FROM human_observer_events_legacy_v26 legacy
      JOIN (
        SELECT project_id,MIN(workspace_id) AS workspace_id
        FROM project_registry
        WHERE revoked_at IS NULL
        GROUP BY project_id
        HAVING COUNT(DISTINCT workspace_id)=1
      ) scopes ON scopes.project_id=legacy.project_id`
    )
    .run();
  database
    .prepare(
      `INSERT INTO human_observer_events_unscoped_legacy(
        cursor,project_id,previous_cursor,event_json,occurred_at,quarantined_at
      )
      SELECT legacy.cursor,legacy.project_id,legacy.previous_cursor,
             legacy.event_json,legacy.occurred_at,?
      FROM human_observer_events_legacy_v26 legacy
      LEFT JOIN (
        SELECT project_id
        FROM project_registry
        WHERE revoked_at IS NULL
        GROUP BY project_id
        HAVING COUNT(DISTINCT workspace_id)=1
      ) scopes ON scopes.project_id=legacy.project_id
      WHERE scopes.project_id IS NULL`
    )
    .run(at);
  database.exec("DROP TABLE human_observer_events_legacy_v26");
}

export const observerWorkspaceScopeMigration: Migration = {
  version: 38,
  sql: "SELECT 1;",
  before: migrateScopedObserverEvents
};
