import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, latestCentralSchemaVersion } from "../migrations.js";
import { HumanObserverJournal } from "../humanObserverJournal.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("HumanObserverJournal", () => {
  it("upgrades a v25 database without rewriting prior migrations", async () => {
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    applyMigrations(database);
    database.exec("DROP TABLE human_observer_events");
    database.prepare("DELETE FROM schema_migrations WHERE version=26").run();

    applyMigrations(database);

    expect(
      database
        .prepare("SELECT version FROM schema_migrations WHERE version=26")
        .get()?.version
    ).toBe(26);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='human_observer_events'"
        )
        .get()?.name
    ).toBe("human_observer_events");
  });

  it("migrates v26 and persists isolated monotonic cursors with bounded replay gaps", async () => {
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    applyMigrations(database);
    expect(latestCentralSchemaVersion).toBe(27);
    const journal = new HumanObserverJournal(database, 2);

    const first = journal.appendInCallerTransaction("project-a", { kind: "membership" });
    const other = journal.appendInCallerTransaction("project-b", { kind: "invitation" });
    const second = journal.appendInCallerTransaction("project-a", { kind: "assignment" });
    const third = journal.appendInCallerTransaction("project-a", { kind: "comment" });
    const fourth = journal.appendInCallerTransaction("project-a", { kind: "activity" });

    expect([first.cursor, other.cursor, second.cursor, third.cursor, fourth.cursor]).toEqual([
      1, 2, 3, 4, 5
    ]);
    expect(second.previousCursor).toBe(first.cursor);
    expect(third.previousCursor).toBe(second.cursor);
    expect(journal.replay("project-b", other.cursor)).toEqual({
      kind: "events",
      headCursor: other.cursor,
      events: []
    });
    expect(journal.replay("project-a", first.cursor)).toMatchObject({
      kind: "gap",
      reason: "retention_gap",
      headCursor: fourth.cursor,
      droppedThroughCursor: second.cursor
    });
    expect(journal.replay("project-a", second.cursor)).toMatchObject({
      kind: "events",
      events: [
        { cursor: third.cursor, previousCursor: second.cursor },
        { cursor: fourth.cursor, previousCursor: third.cursor }
      ]
    });
    expect(journal.replay("project-a", fourth.cursor + 1)).toMatchObject({
      kind: "gap",
      reason: "cursor_ahead",
      headCursor: fourth.cursor
    });

    const observed: number[] = [];
    journal.subscribe("project-rollback", (event) => observed.push(event.cursor));
    database.exec("BEGIN IMMEDIATE");
    journal.appendInCallerTransaction("project-rollback", { kind: "project" });
    database.exec("ROLLBACK");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(observed).toEqual([]);
    expect(journal.head("project-rollback")).toBe(0);
  });
});
