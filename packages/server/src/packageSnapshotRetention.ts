import { rm } from "node:fs/promises";
import { PACKAGE_SNAPSHOT_MAX_RETAINED } from "@planweave-ai/collaboration-protocol/core/limits";
import { backingPath } from "./packageSnapshotBacking.js";
import type { SqliteDatabase } from "./sqlite.js";

export async function enforcePackageSnapshotRetention(
  database: SqliteDatabase,
  dataDirectory: string,
  canvasRegistryId: string,
  at: string
): Promise<void> {
  const rows = database
    .prepare(
      `SELECT snapshot_id FROM package_snapshots WHERE canvas_registry_id=? AND state='available' ORDER BY rowid DESC LIMIT ?`
    )
    .all(canvasRegistryId, PACKAGE_SNAPSHOT_MAX_RETAINED + 1) as Array<{
    snapshot_id: string;
  }>;
  const failures: unknown[] = [];
  const revokedRows = database
    .prepare(
      "SELECT snapshot_id FROM package_snapshots WHERE canvas_registry_id=? AND state='revoked' ORDER BY rowid LIMIT ?"
    )
    .all(canvasRegistryId, PACKAGE_SNAPSHOT_MAX_RETAINED) as Array<{
    snapshot_id: string;
  }>;
  for (const row of revokedRows) {
    try {
      await rm(backingPath(dataDirectory, row.snapshot_id), {
        recursive: true,
        force: true
      });
    } catch (error) {
      failures.push(error);
    }
  }
  for (const row of rows.slice(PACKAGE_SNAPSHOT_MAX_RETAINED)) {
    database
      .prepare(
        "UPDATE package_snapshots SET state='revoked',revoked_at=?,updated_at=? WHERE snapshot_id=? AND canvas_registry_id=? AND state='available'"
      )
      .run(at, at, row.snapshot_id, canvasRegistryId);
    try {
      await rm(backingPath(dataDirectory, row.snapshot_id), {
        recursive: true,
        force: true
      });
    } catch (error) {
      failures.push(error);
    }
  }
  const retained = database
    .prepare(
      "SELECT snapshot_id FROM package_snapshots WHERE canvas_registry_id=? AND state='available' ORDER BY rowid DESC LIMIT ?"
    )
    .all(canvasRegistryId, PACKAGE_SNAPSHOT_MAX_RETAINED) as Array<{
    snapshot_id: string;
  }>;
  const rankBase = retained.length;
  retained.forEach((row, index) => {
    database
      .prepare(
        "UPDATE package_snapshots SET retention_order=?,updated_at=? WHERE snapshot_id=? AND canvas_registry_id=? AND state='available'"
      )
      .run(rankBase - index, at, row.snapshot_id, canvasRegistryId);
  });
  if (failures.length > 0) throw new AggregateError(failures, "snapshot_retention_cleanup_failed");
}
