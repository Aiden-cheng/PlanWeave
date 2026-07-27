import type { SqliteDatabase } from "./sqlite.js";

/**
 * A pending snapshot restore is a durable authorization lease for its scope.
 * Mutations that could change access must fail while the lease is held so the
 * restore cannot commit a package after an authorization change.
 */
export function assertNoPendingSnapshotRestore(
  database: SqliteDatabase,
  input: { workspaceId: string; projectId: string; canvasId?: string | null }
): void {
  const row = input.canvasId
    ? database
        .prepare(
          `SELECT snapshot_id FROM package_snapshots
           WHERE workspace_id=? AND project_id=? AND canvas_id=?
             AND state='available' AND restore_marker='restore_pending'
           LIMIT 1`
        )
        .get(input.workspaceId, input.projectId, input.canvasId)
    : database
        .prepare(
          `SELECT snapshot_id FROM package_snapshots
           WHERE workspace_id=? AND project_id=?
             AND state='available' AND restore_marker='restore_pending'
           LIMIT 1`
        )
        .get(input.workspaceId, input.projectId);
  if (row) throw new Error("snapshot_restore_pending");
}
