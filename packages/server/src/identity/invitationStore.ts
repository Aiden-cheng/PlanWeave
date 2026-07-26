import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../sqlite.js";
import { digestsEqual, hashHumanToken, mintProjectInvitationToken } from "./crypto.js";
import { HumanIdentityError, isHumanIdentityUniqueViolation } from "./errors.js";
import { PROJECT_INVITATION_DEFAULT_TTL_MS } from "./limits.js";
import {
  humanPrincipalIdSchema,
  humanProjectIdSchema,
  projectInvitationIdSchema,
  projectInvitationMetadataSchema,
  projectInvitationTokenSchema,
  projectInvitationTtlMsSchema,
  type ProjectInvitationMetadata
} from "./schemas.js";

type InvitationRow = {
  invitation_id: string;
  project_id: string;
  role: string;
  created_by_human_principal_id: string;
  token_sha256: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  consumed_at: string | null;
  consumed_by_human_principal_id: string | null;
};

function toInvitation(row: InvitationRow): ProjectInvitationMetadata {
  return projectInvitationMetadataSchema.parse({
    invitationId: row.invitation_id,
    projectId: row.project_id,
    role: row.role,
    createdByHumanPrincipalId: row.created_by_human_principal_id,
    tokenSha256: row.token_sha256,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at ?? undefined,
    consumedAt: row.consumed_at ?? undefined,
    consumedByHumanPrincipalId: row.consumed_by_human_principal_id ?? undefined
  });
}

export class InvitationStore {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date
  ) {}

  getInvitation(invitationId: string): ProjectInvitationMetadata | undefined {
    const id = projectInvitationIdSchema.parse(invitationId);
    const row = this.database
      .prepare("SELECT * FROM project_invitations WHERE invitation_id=?")
      .get(id) as InvitationRow | undefined;
    return row ? toInvitation(row) : undefined;
  }

  findInvitationByToken(invitationToken: string): ProjectInvitationMetadata | undefined {
    const parsed = projectInvitationTokenSchema.safeParse(invitationToken);
    if (!parsed.success) return undefined;
    const digest = hashHumanToken(parsed.data);
    const row = this.database
      .prepare("SELECT * FROM project_invitations WHERE token_sha256=?")
      .get(digest) as InvitationRow | undefined;
    if (!row || !digestsEqual(row.token_sha256, digest)) return undefined;
    return toInvitation(row);
  }

  listInvitations(
    projectId: string,
    limit = 100,
    offset = 0,
    options: { openOnly?: boolean } = {}
  ): ProjectInvitationMetadata[] {
    const pid = humanProjectIdSchema.parse(projectId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new HumanIdentityError("human_input_invalid");
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new HumanIdentityError("human_input_invalid");
    }
    if (options.openOnly) {
      return (
        this.database
          .prepare(
            `SELECT * FROM project_invitations
             WHERE project_id=? AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at>?
             ORDER BY created_at ASC, invitation_id ASC
             LIMIT ? OFFSET ?`
          )
          .all(pid, this.clock().toISOString(), limit, offset) as InvitationRow[]
      ).map(toInvitation);
    }
    return (
      this.database
        .prepare(
          `SELECT * FROM project_invitations
           WHERE project_id=?
           ORDER BY created_at ASC, invitation_id ASC
           LIMIT ? OFFSET ?`
        )
        .all(pid, limit, offset) as InvitationRow[]
    ).map(toInvitation);
  }

  countOpenInvitations(projectId: string): number {
    const pid = humanProjectIdSchema.parse(projectId);
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM project_invitations
         WHERE project_id=? AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at>?`
      )
      .get(pid, this.clock().toISOString()) as { count: number };
    return Number(row.count);
  }

  insertInvitation(input: {
    projectId: string;
    createdByHumanPrincipalId: string;
    ttlMs?: number;
  }): { invitation: ProjectInvitationMetadata; invitationToken: string } {
    const projectId = humanProjectIdSchema.parse(input.projectId);
    const createdBy = humanPrincipalIdSchema.parse(input.createdByHumanPrincipalId);
    const ttlMs =
      input.ttlMs === undefined
        ? PROJECT_INVITATION_DEFAULT_TTL_MS
        : projectInvitationTtlMsSchema.parse(input.ttlMs);
    const now = this.clock();
    const invitationToken = mintProjectInvitationToken();
    const tokenSha256 = hashHumanToken(invitationToken);
    const invitationId = projectInvitationIdSchema.parse(randomUUID());
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

    try {
      this.database
        .prepare(
          `INSERT INTO project_invitations(
            invitation_id,project_id,role,created_by_human_principal_id,token_sha256,
            created_at,expires_at
          ) VALUES (?,?,?,?,?,?,?)`
        )
        .run(invitationId, projectId, "member", createdBy, tokenSha256, createdAt, expiresAt);
    } catch (error) {
      if (isHumanIdentityUniqueViolation(error)) {
        throw new HumanIdentityError("human_input_invalid", "Invitation token digest conflict.");
      }
      throw error;
    }

    return { invitation: this.getInvitation(invitationId)!, invitationToken };
  }

  revokeInvitation(invitationId: string, projectId: string): ProjectInvitationMetadata {
    const id = projectInvitationIdSchema.parse(invitationId);
    const pid = humanProjectIdSchema.parse(projectId);
    const invitation = this.getInvitation(id);
    if (!invitation || invitation.projectId !== pid) {
      throw new HumanIdentityError("human_invitation_invalid");
    }
    if (invitation.revokedAt) throw new HumanIdentityError("human_invitation_revoked");
    if (invitation.consumedAt) throw new HumanIdentityError("human_invitation_consumed");
    const updated = this.database
      .prepare(
        `UPDATE project_invitations SET revoked_at=?
         WHERE invitation_id=? AND revoked_at IS NULL AND consumed_at IS NULL`
      )
      .run(this.clock().toISOString(), id);
    if (updated.changes !== 1) throw new HumanIdentityError("human_invitation_invalid");
    return this.getInvitation(id)!;
  }

  markConsumed(invitationId: string, humanPrincipalId: string): ProjectInvitationMetadata {
    const id = projectInvitationIdSchema.parse(invitationId);
    const hid = humanPrincipalIdSchema.parse(humanPrincipalId);
    const updated = this.database
      .prepare(
        `UPDATE project_invitations
         SET consumed_at=?, consumed_by_human_principal_id=?
         WHERE invitation_id=? AND consumed_at IS NULL AND revoked_at IS NULL`
      )
      .run(this.clock().toISOString(), hid, id);
    if (updated.changes !== 1) throw new HumanIdentityError("human_invitation_consumed");
    return this.getInvitation(id)!;
  }
}
