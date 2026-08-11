import { afterEach, describe, expect, it } from "vitest";
import { hostInstallationIdentityMigration } from "../migrations/hostInstallationIdentity.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("Host installation identity migration v48", () => {
  it("adds nullable generation metadata and enforces one current Host per installation", async () => {
    const database = await openServerDatabase(":memory:", 5_000);
    databases.push(database);
    database.exec(`
      CREATE TABLE agent_hosts (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL
      );
      INSERT INTO agent_hosts(id,display_name) VALUES ('legacy-host','Legacy Host');
    `);

    hostInstallationIdentityMigration.before?.(database);
    hostInstallationIdentityMigration.before?.(database);

    expect(
      database
        .prepare("SELECT installation_id,superseded_at,superseded_by_host_id FROM agent_hosts")
        .get()
    ).toEqual({
      installation_id: null,
      superseded_at: null,
      superseded_by_host_id: null
    });
    database
      .prepare("UPDATE agent_hosts SET installation_id=? WHERE id='legacy-host'")
      .run("3f670d52-e2ec-4c7e-8605-e687233bcd37");
    expect(() =>
      database
        .prepare("INSERT INTO agent_hosts(id,display_name,installation_id) VALUES (?,?,?)")
        .run("duplicate-current", "Duplicate", "3f670d52-e2ec-4c7e-8605-e687233bcd37")
    ).toThrow();
    database
      .prepare("UPDATE agent_hosts SET superseded_at=? WHERE id='legacy-host'")
      .run("2030-01-01T00:00:00.000Z");
    expect(() =>
      database
        .prepare("INSERT INTO agent_hosts(id,display_name,installation_id) VALUES (?,?,?)")
        .run("current", "Current", "3f670d52-e2ec-4c7e-8605-e687233bcd37")
    ).not.toThrow();
  });
});
