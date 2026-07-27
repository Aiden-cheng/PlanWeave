import { createHash } from "node:crypto";
import type { SqliteDatabase } from "../sqlite.js";

export type WorkspaceMembershipProjection = {
  workspaceId: string;
  membershipId: string;
  humanPrincipalId: string;
  role: "owner" | "member";
  revision: number;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
};

type SourceMembership = {
  membership_id: string;
  human_principal_id: string;
  role: "owner" | "member";
  revision: number | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
};

/** Stable workspace-scoped membership identity, independent of any legacy project row. */
export function workspaceMembershipIdFor(workspaceId: string, humanPrincipalId: string): string {
  return `workspace-membership-${createHash("sha256")
    .update(`${workspaceId}:${humanPrincipalId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function sourceMemberships(
  database: SqliteDatabase,
  workspaceId: string,
  currentProjectId?: string
): SourceMembership[] {
  return database
    .prepare(
      `SELECT p.membership_id,p.human_principal_id,p.role,p.revision,p.created_at,p.updated_at,p.revoked_at
       FROM project_memberships p
       JOIN legacy_project_workspace_mappings map ON map.legacy_project_id=p.project_id
       JOIN workspace_identity_migrations migration
         ON migration.legacy_project_id=p.project_id
       WHERE map.workspace_id=?
         AND (
           (migration.status='completed' AND migration.interruption_marker='read_cutover_complete')
           OR migration.legacy_project_id=?
         )
       ORDER BY p.human_principal_id,p.membership_id`
    )
    .all(workspaceId, currentProjectId ?? "")
    .map((row) => ({
      membership_id: String(row.membership_id),
      human_principal_id: String(row.human_principal_id),
      role: row.role as SourceMembership["role"],
      revision: row.revision === null ? null : Number(row.revision),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      revoked_at: row.revoked_at === null ? null : String(row.revoked_at)
    }));
}

function maxTimestamp(values: string[]): string {
  return values.reduce((latest, value) => (value > latest ? value : latest));
}

function minTimestamp(values: string[]): string {
  return values.reduce((earliest, value) => (value < earliest ? value : earliest));
}

/**
 * Compute the one workspace membership projection for each human principal.
 * Only completed peer migrations are authoritative; currentProjectId is included
 * explicitly while its migration is still in progress.
 */
export function workspaceMembershipProjections(
  database: SqliteDatabase,
  workspaceId: string,
  currentProjectId?: string
): WorkspaceMembershipProjection[] {
  const grouped = new Map<string, SourceMembership[]>();
  for (const source of sourceMemberships(database, workspaceId, currentProjectId)) {
    const rows = grouped.get(source.human_principal_id) ?? [];
    rows.push(source);
    grouped.set(source.human_principal_id, rows);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([humanPrincipalId, rows]) => {
      const activeRows = rows.filter((row) => row.revoked_at === null);
      const role = activeRows.some((row) => row.role === "owner")
        ? "owner"
        : activeRows.length > 0
          ? "member"
          : [...rows].sort((left, right) => {
              const revisionDelta = Number(right.revision ?? 1) - Number(left.revision ?? 1);
              if (revisionDelta !== 0) return revisionDelta;
              const updatedDelta = right.updated_at.localeCompare(left.updated_at);
              return updatedDelta !== 0
                ? updatedDelta
                : right.membership_id.localeCompare(left.membership_id);
            })[0].role;
      const revision = Math.max(...rows.map((row) => Number(row.revision ?? 1)));
      const createdAt = minTimestamp(rows.map((row) => row.created_at));
      const updatedAt = maxTimestamp(rows.map((row) => row.updated_at));
      const revokedAt =
        activeRows.length > 0
          ? null
          : maxTimestamp(rows.map((row) => row.revoked_at ?? row.updated_at));
      return {
        workspaceId,
        membershipId: workspaceMembershipIdFor(workspaceId, humanPrincipalId),
        humanPrincipalId,
        role,
        revision,
        createdAt,
        updatedAt,
        revokedAt
      };
    });
}

/** Persist the canonical one-row-per-principal workspace membership projection. */
export function projectWorkspaceMemberships(
  database: SqliteDatabase,
  workspaceId: string,
  currentProjectId?: string,
  options: { strictSourceConflicts?: boolean } = {}
): WorkspaceMembershipProjection[] {
  if (options.strictSourceConflicts) {
    const prior = new Map(
      workspaceMembershipProjections(database, workspaceId).map((projection) => [
        projection.membershipId,
        projection
      ])
    );
    const target = new Map(
      workspaceMembershipProjections(database, workspaceId, currentProjectId).map((projection) => [
        projection.membershipId,
        projection
      ])
    );
    const sameProjection = (
      row: Record<string, unknown>,
      projection: WorkspaceMembershipProjection
    ) =>
      row.human_principal_id === projection.humanPrincipalId &&
      row.role === projection.role &&
      Number(row.revision) === projection.revision &&
      row.created_at === projection.createdAt &&
      row.updated_at === projection.updatedAt &&
      row.revoked_at === projection.revokedAt;
    for (const row of database
      .prepare(
        `SELECT membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at
         FROM workspace_memberships WHERE workspace_id=?`
      )
      .all(workspaceId)) {
      const membershipId = String(row.membership_id);
      const priorProjection = prior.get(membershipId);
      const targetProjection = target.get(membershipId);
      if (
        (!priorProjection || !sameProjection(row, priorProjection)) &&
        (!targetProjection || !sameProjection(row, targetProjection))
      ) {
        throw new Error("workspace_membership_projection_conflict");
      }
    }
  }
  const projections = workspaceMembershipProjections(database, workspaceId, currentProjectId);
  const projectionIds = new Set(projections.map((projection) => projection.membershipId));
  const existing = database
    .prepare("SELECT membership_id FROM workspace_memberships WHERE workspace_id=?")
    .all(workspaceId);
  for (const row of existing) {
    if (!projectionIds.has(String(row.membership_id))) {
      database
        .prepare("DELETE FROM workspace_memberships WHERE workspace_id=? AND membership_id=?")
        .run(workspaceId, row.membership_id);
    }
  }
  const statement = database.prepare(
    `INSERT INTO workspace_memberships(
       workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at
     ) VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(workspace_id,membership_id) DO UPDATE SET
       human_principal_id=excluded.human_principal_id,
       role=excluded.role,revision=excluded.revision,created_at=excluded.created_at,
       updated_at=excluded.updated_at,revoked_at=excluded.revoked_at`
  );
  for (const projection of projections) {
    if (
      !database
        .prepare("SELECT 1 FROM workspace_principals WHERE workspace_id=? AND human_principal_id=?")
        .get(workspaceId, projection.humanPrincipalId)
    ) {
      continue;
    }
    statement.run(
      projection.workspaceId,
      projection.membershipId,
      projection.humanPrincipalId,
      projection.role,
      projection.revision,
      projection.createdAt,
      projection.updatedAt,
      projection.revokedAt
    );
  }
  return projections;
}
