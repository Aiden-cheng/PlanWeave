import { randomUUID } from "node:crypto";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import {
  digestsEqual,
  hashHumanToken,
  mintHumanDeviceToken,
  mintProjectInvitationToken
} from "./crypto.js";
import { HUMAN_AUTH_ERROR_MESSAGES, type HumanAuthErrorCode } from "./errors.js";
import {
  HUMAN_MAX_DEVICES_PER_PRINCIPAL,
  HUMAN_MAX_MEMBERS_PER_PROJECT,
  HUMAN_MAX_OPEN_INVITATIONS_PER_PROJECT,
  PROJECT_INVITATION_DEFAULT_TTL_MS
} from "./limits.js";
import {
  evaluateDeviceUsability,
  evaluateInvitationUsability,
  humanDeviceCredentialIdSchema,
  humanDeviceCredentialMetadataSchema,
  humanDeviceLabelSchema,
  humanDeviceTokenSchema,
  humanDeviceTtlMsSchema,
  humanDisplayNameSchema,
  humanPrincipalIdSchema,
  humanPrincipalSchema,
  humanProjectIdSchema,
  isActiveMembership,
  localAdministrativeProofSchema,
  projectInvitationIdSchema,
  projectInvitationMetadataSchema,
  projectInvitationTokenSchema,
  projectInvitationTtlMsSchema,
  projectMembershipIdSchema,
  projectMembershipSchema,
  type HumanDeviceCredentialMetadata,
  type HumanPrincipal,
  type LocalAdministrativeProof,
  type ProjectInvitationMetadata,
  type ProjectMemberRole,
  type ProjectMembership
} from "./schemas.js";

export class HumanIdentityError extends Error {
  constructor(
    readonly code: HumanAuthErrorCode,
    message: string = HUMAN_AUTH_ERROR_MESSAGES[code]
  ) {
    super(message);
    this.name = "HumanIdentityError";
  }
}

type PrincipalRow = {
  human_principal_id: string;
  display_name: string;
  created_at: string;
};

type MembershipRow = {
  membership_id: string;
  project_id: string;
  human_principal_id: string;
  role: string;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
};

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

type DeviceRow = {
  device_credential_id: string;
  human_principal_id: string;
  minted_for_project_id: string;
  label: string | null;
  token_sha256: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
};

export type BootstrapOwnerResult = {
  principal: HumanPrincipal;
  membership: ProjectMembership;
  device: HumanDeviceCredentialMetadata;
  /**
   * Plaintext device secret. Returned on first bootstrap and on recovery re-bootstrap
   * when no usable device remains. Omitted when an existing usable device is reused.
   */
  deviceToken?: string;
  created: boolean;
};

export type CreateInvitationResult = {
  invitation: ProjectInvitationMetadata;
  /** Plaintext invitation secret; returned exactly once at creation. */
  invitationToken: string;
};

export type ConsumeInvitationResult = {
  principal: HumanPrincipal;
  membership: ProjectMembership;
  device: HumanDeviceCredentialMetadata;
  /** Plaintext device secret for the newly minted credential; returned once. */
  deviceToken: string;
  invitation: ProjectInvitationMetadata;
  /** True when a new principal row was created for this consumption. */
  principalCreated: boolean;
};

export type AuthenticatedHumanDevice = {
  principal: HumanPrincipal;
  device: HumanDeviceCredentialMetadata;
  membership?: ProjectMembership;
};

function toPrincipal(row: PrincipalRow): HumanPrincipal {
  return humanPrincipalSchema.parse({
    humanPrincipalId: row.human_principal_id,
    displayName: row.display_name,
    createdAt: row.created_at
  });
}

function toMembership(row: MembershipRow): ProjectMembership {
  return projectMembershipSchema.parse({
    membershipId: row.membership_id,
    projectId: row.project_id,
    humanPrincipalId: row.human_principal_id,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at ?? undefined
  });
}

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

function toDevice(row: DeviceRow): HumanDeviceCredentialMetadata {
  return humanDeviceCredentialMetadataSchema.parse({
    deviceCredentialId: row.device_credential_id,
    humanPrincipalId: row.human_principal_id,
    mintedForProjectId: row.minted_for_project_id,
    label: row.label ?? undefined,
    tokenSha256: row.token_sha256,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    lastUsedAt: row.last_used_at ?? undefined
  });
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

/**
 * SQLite repositories for human principals, project memberships, invitations, and devices.
 * Stores only token digests and safe metadata. Plaintext secrets leave this layer at most once.
 */
export class HumanIdentityRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date()
  ) {}

  getPrincipal(humanPrincipalId: string): HumanPrincipal | undefined {
    const id = humanPrincipalIdSchema.parse(humanPrincipalId);
    const row = this.database
      .prepare("SELECT * FROM human_principals WHERE human_principal_id=?")
      .get(id) as PrincipalRow | undefined;
    return row ? toPrincipal(row) : undefined;
  }

  getMembership(membershipId: string): ProjectMembership | undefined {
    const id = projectMembershipIdSchema.parse(membershipId);
    const row = this.database
      .prepare("SELECT * FROM project_memberships WHERE membership_id=?")
      .get(id) as MembershipRow | undefined;
    return row ? toMembership(row) : undefined;
  }

  getActiveMembership(projectId: string, humanPrincipalId: string): ProjectMembership | undefined {
    const pid = humanProjectIdSchema.parse(projectId);
    const hid = humanPrincipalIdSchema.parse(humanPrincipalId);
    const row = this.database
      .prepare(
        `SELECT * FROM project_memberships
         WHERE project_id=? AND human_principal_id=? AND revoked_at IS NULL`
      )
      .get(pid, hid) as MembershipRow | undefined;
    return row ? toMembership(row) : undefined;
  }

  countActiveOwners(projectId: string): number {
    const pid = humanProjectIdSchema.parse(projectId);
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM project_memberships
         WHERE project_id=? AND role='owner' AND revoked_at IS NULL`
      )
      .get(pid) as { count: number };
    return Number(row.count);
  }

  countActiveMembers(projectId: string): number {
    const pid = humanProjectIdSchema.parse(projectId);
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM project_memberships
         WHERE project_id=? AND revoked_at IS NULL`
      )
      .get(pid) as { count: number };
    return Number(row.count);
  }

  listActiveMembers(projectId: string, limit = 100, offset = 0): ProjectMembership[] {
    const pid = humanProjectIdSchema.parse(projectId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new HumanIdentityError("human_input_invalid");
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new HumanIdentityError("human_input_invalid");
    }
    return (
      this.database
        .prepare(
          `SELECT * FROM project_memberships
           WHERE project_id=? AND revoked_at IS NULL
           ORDER BY created_at ASC, membership_id ASC
           LIMIT ? OFFSET ?`
        )
        .all(pid, limit, offset) as MembershipRow[]
    ).map(toMembership);
  }

  getInvitation(invitationId: string): ProjectInvitationMetadata | undefined {
    const id = projectInvitationIdSchema.parse(invitationId);
    const row = this.database
      .prepare("SELECT * FROM project_invitations WHERE invitation_id=?")
      .get(id) as InvitationRow | undefined;
    return row ? toInvitation(row) : undefined;
  }

  /**
   * Lookup invitation metadata by plaintext bearer. Uses constant-time digest compare.
   * Returns undefined for unknown tokens without distinguishing prior validity.
   */
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

  getDevice(deviceCredentialId: string): HumanDeviceCredentialMetadata | undefined {
    const id = humanDeviceCredentialIdSchema.parse(deviceCredentialId);
    const row = this.database
      .prepare("SELECT * FROM human_device_credentials WHERE device_credential_id=?")
      .get(id) as DeviceRow | undefined;
    return row ? toDevice(row) : undefined;
  }

  listDevicesForPrincipal(
    humanPrincipalId: string,
    projectId: string,
    limit = 100,
    offset = 0
  ): HumanDeviceCredentialMetadata[] {
    const hid = humanPrincipalIdSchema.parse(humanPrincipalId);
    const pid = humanProjectIdSchema.parse(projectId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new HumanIdentityError("human_input_invalid");
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new HumanIdentityError("human_input_invalid");
    }
    return (
      this.database
        .prepare(
          `SELECT * FROM human_device_credentials
           WHERE human_principal_id=? AND minted_for_project_id=?
           ORDER BY created_at ASC, device_credential_id ASC
           LIMIT ? OFFSET ?`
        )
        .all(hid, pid, limit, offset) as DeviceRow[]
    ).map(toDevice);
  }

  /**
   * Devices belonging to active members of a project (owner project-device inventory).
   * Does not include digests in higher layers; this returns repository metadata only.
   */
  listDevicesForProjectMembers(
    projectId: string,
    limit = 100,
    offset = 0
  ): HumanDeviceCredentialMetadata[] {
    const pid = humanProjectIdSchema.parse(projectId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new HumanIdentityError("human_input_invalid");
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new HumanIdentityError("human_input_invalid");
    }
    return (
      this.database
        .prepare(
          `SELECT d.* FROM human_device_credentials d
           INNER JOIN project_memberships m
             ON m.human_principal_id = d.human_principal_id
            AND m.project_id = ?
            AND m.revoked_at IS NULL
           WHERE d.minted_for_project_id = ?
           ORDER BY d.created_at ASC, d.device_credential_id ASC
           LIMIT ? OFFSET ?`
        )
        .all(pid, pid, limit, offset) as DeviceRow[]
    ).map(toDevice);
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
    const now = this.clock().toISOString();
    if (options.openOnly) {
      return (
        this.database
          .prepare(
            `SELECT * FROM project_invitations
             WHERE project_id=? AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at>?
             ORDER BY created_at ASC, invitation_id ASC
             LIMIT ? OFFSET ?`
          )
          .all(pid, now, limit, offset) as InvitationRow[]
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

  /**
   * Local-admin owner bootstrap. Concurrent first owners for different principals conflict.
   * Same principal re-bootstrap is idempotent: does not re-mint when a usable device remains;
   * if every device is revoked/expired, mints a recovery device token (still one owner).
   */
  bootstrapOwner(
    proofInput: unknown,
    options: { deviceLabel?: string; deviceTtlMs?: number } = {}
  ): BootstrapOwnerResult {
    const proof = localAdministrativeProofSchema.parse(proofInput);
    return inWriteTransaction(this.database, () => this.bootstrapOwnerLocked(proof, options));
  }

  createInvitation(input: {
    projectId: string;
    createdByHumanPrincipalId: string;
    ttlMs?: number;
  }): CreateInvitationResult {
    return inWriteTransaction(this.database, () => this.createInvitationLocked(input));
  }

  revokeInvitation(invitationId: string, projectId: string): ProjectInvitationMetadata {
    return inWriteTransaction(this.database, () => {
      const id = projectInvitationIdSchema.parse(invitationId);
      const pid = humanProjectIdSchema.parse(projectId);
      const row = this.database
        .prepare("SELECT * FROM project_invitations WHERE invitation_id=?")
        .get(id) as InvitationRow | undefined;
      if (!row || row.project_id !== pid) {
        throw new HumanIdentityError("human_invitation_invalid");
      }
      if (row.revoked_at) {
        throw new HumanIdentityError("human_invitation_revoked");
      }
      if (row.consumed_at) {
        throw new HumanIdentityError("human_invitation_consumed");
      }
      const now = this.clock().toISOString();
      const updated = this.database
        .prepare(
          `UPDATE project_invitations SET revoked_at=?
           WHERE invitation_id=? AND revoked_at IS NULL AND consumed_at IS NULL`
        )
        .run(now, id);
      if (updated.changes !== 1) {
        throw new HumanIdentityError("human_invitation_invalid");
      }
      return this.getInvitation(id)!;
    });
  }

  /**
   * Consume a one-time invitation.
   *
   * - Without a valid existing device token: create a new principal (no display-name lookup;
   *   avoids account enumeration) and mint a device for the join project.
   * - With a valid existing device token: attach membership to that principal and mint a new
   *   device scoped to this project. Does not grant implicit access to any other project.
   */
  consumeInvitation(input: {
    invitationToken: string;
    projectId: string;
    displayName: string;
    deviceLabel?: string;
    deviceTtlMs?: number;
    existingDeviceToken?: string;
  }): ConsumeInvitationResult {
    return inWriteTransaction(this.database, () => this.consumeInvitationLocked(input));
  }

  /**
   * Authenticate a human device bearer. Constant-time digest check after hash lookup.
   * Optionally resolve active membership for the immutable project that minted the device.
   */
  authenticateDevice(
    deviceToken: string,
    projectId?: string
  ): AuthenticatedHumanDevice | undefined {
    const token = humanDeviceTokenSchema.safeParse(deviceToken);
    if (!token.success) return undefined;
    const digest = hashHumanToken(token.data);
    const row = this.database
      .prepare("SELECT * FROM human_device_credentials WHERE token_sha256=?")
      .get(digest) as DeviceRow | undefined;
    if (!row) return undefined;
    if (!digestsEqual(row.token_sha256, digest)) return undefined;

    const device = toDevice(row);
    const principal = this.getPrincipal(device.humanPrincipalId);
    if (!principal) return undefined;

    const usability = evaluateDeviceUsability({
      device,
      humanPrincipalId: principal.humanPrincipalId,
      now: this.clock()
    });
    if (!usability.usable) return undefined;

    let membership: ProjectMembership | undefined;
    if (projectId !== undefined) {
      const pid = humanProjectIdSchema.parse(projectId);
      if (device.mintedForProjectId !== pid) return undefined;
      membership = this.getActiveMembership(pid, principal.humanPrincipalId);
      if (!membership) return undefined;
    }

    this.database
      .prepare(
        `UPDATE human_device_credentials SET last_used_at=?
         WHERE device_credential_id=? AND revoked_at IS NULL`
      )
      .run(this.clock().toISOString(), device.deviceCredentialId);

    const refreshed = this.getDevice(device.deviceCredentialId)!;
    return { principal, device: refreshed, membership };
  }

  revokeDevice(
    deviceCredentialId: string,
    projectId: string,
    ownerHumanPrincipalId?: string
  ): HumanDeviceCredentialMetadata {
    return inWriteTransaction(this.database, () => {
      const id = humanDeviceCredentialIdSchema.parse(deviceCredentialId);
      const pid = humanProjectIdSchema.parse(projectId);
      const row = this.database
        .prepare("SELECT * FROM human_device_credentials WHERE device_credential_id=?")
        .get(id) as DeviceRow | undefined;
      if (!row) throw new HumanIdentityError("human_input_invalid");
      if (row.minted_for_project_id !== pid) {
        throw new HumanIdentityError("human_cross_project_forbidden");
      }
      if (
        ownerHumanPrincipalId !== undefined &&
        row.human_principal_id !== humanPrincipalIdSchema.parse(ownerHumanPrincipalId)
      ) {
        throw new HumanIdentityError("human_device_not_owner");
      }
      if (row.revoked_at) throw new HumanIdentityError("human_device_revoked");
      const now = this.clock().toISOString();
      const updated = this.database
        .prepare(
          `UPDATE human_device_credentials SET revoked_at=?
           WHERE device_credential_id=? AND minted_for_project_id=? AND revoked_at IS NULL`
        )
        .run(now, id, pid);
      if (updated.changes !== 1) throw new HumanIdentityError("human_device_revoked");
      return this.getDevice(id)!;
    });
  }

  /**
   * Soft-revoke membership. Last active owner cannot be removed.
   * Revokes devices minted for this project for the removed principal only.
   * Other projects' memberships and devices are untouched.
   */
  removeMember(projectId: string, targetHumanPrincipalId: string): ProjectMembership {
    return inWriteTransaction(this.database, () => {
      const pid = humanProjectIdSchema.parse(projectId);
      const target = humanPrincipalIdSchema.parse(targetHumanPrincipalId);
      const membership = this.getActiveMembership(pid, target);
      if (!membership) throw new HumanIdentityError("human_membership_required");

      if (membership.role === "owner") {
        const owners = this.countActiveOwners(pid);
        if (owners <= 1) throw new HumanIdentityError("human_last_owner_protected");
      }

      const now = this.clock().toISOString();
      const updated = this.database
        .prepare(
          `UPDATE project_memberships SET revoked_at=?, updated_at=?
           WHERE membership_id=? AND revoked_at IS NULL`
        )
        .run(now, now, membership.membershipId);
      if (updated.changes !== 1) throw new HumanIdentityError("human_membership_required");

      this.database
        .prepare(
          `UPDATE human_device_credentials SET revoked_at=?
           WHERE human_principal_id=? AND minted_for_project_id=? AND revoked_at IS NULL`
        )
        .run(now, target, pid);

      return this.getMembership(membership.membershipId)!;
    });
  }

  promoteToOwner(projectId: string, targetHumanPrincipalId: string): ProjectMembership {
    return inWriteTransaction(this.database, () => {
      const pid = humanProjectIdSchema.parse(projectId);
      const target = humanPrincipalIdSchema.parse(targetHumanPrincipalId);
      const membership = this.getActiveMembership(pid, target);
      if (!membership) throw new HumanIdentityError("human_membership_required");
      if (membership.role === "owner") return membership;
      const now = this.clock().toISOString();
      const updated = this.database
        .prepare(
          `UPDATE project_memberships SET role='owner', updated_at=?
           WHERE membership_id=? AND revoked_at IS NULL AND role='member'`
        )
        .run(now, membership.membershipId);
      if (updated.changes !== 1) throw new HumanIdentityError("human_membership_required");
      return this.getMembership(membership.membershipId)!;
    });
  }

  demoteOwner(projectId: string, targetHumanPrincipalId: string): ProjectMembership {
    return inWriteTransaction(this.database, () => {
      const pid = humanProjectIdSchema.parse(projectId);
      const target = humanPrincipalIdSchema.parse(targetHumanPrincipalId);
      const membership = this.getActiveMembership(pid, target);
      if (!membership) throw new HumanIdentityError("human_membership_required");
      if (membership.role !== "owner") throw new HumanIdentityError("human_input_invalid");
      if (this.countActiveOwners(pid) <= 1) {
        throw new HumanIdentityError("human_last_owner_protected");
      }
      const now = this.clock().toISOString();
      const updated = this.database
        .prepare(
          `UPDATE project_memberships SET role='member', updated_at=?
           WHERE membership_id=? AND revoked_at IS NULL AND role='owner'`
        )
        .run(now, membership.membershipId);
      if (updated.changes !== 1) throw new HumanIdentityError("human_last_owner_protected");
      return this.getMembership(membership.membershipId)!;
    });
  }

  private bootstrapOwnerLocked(
    proof: LocalAdministrativeProof,
    options: { deviceLabel?: string; deviceTtlMs?: number }
  ): BootstrapOwnerResult {
    const projectId = proof.projectId;
    const existingOwners = this.database
      .prepare(
        `SELECT * FROM project_memberships
         WHERE project_id=? AND role='owner' AND revoked_at IS NULL
         ORDER BY created_at ASC, membership_id ASC`
      )
      .all(projectId) as MembershipRow[];

    const samePrincipal = existingOwners.find(
      (row) => row.human_principal_id === proof.humanPrincipalId
    );
    if (existingOwners.length > 0 && !samePrincipal) {
      throw new HumanIdentityError("human_bootstrap_conflict");
    }

    if (samePrincipal) {
      const principal =
        this.getPrincipal(proof.humanPrincipalId) ??
        this.insertPrincipal(proof.humanPrincipalId, proof.displayName);
      const usable = this.findUsableDevice(proof.humanPrincipalId);
      if (usable) {
        return {
          principal,
          membership: toMembership(samePrincipal),
          device: usable,
          created: false
        };
      }
      // Recovery: owner membership exists but no active usable device remains.
      // Local-admin re-bootstrap mints a one-shot token without creating a second owner.
      const recovered = this.insertDevice({
        humanPrincipalId: principal.humanPrincipalId,
        mintedForProjectId: projectId,
        label: options.deviceLabel,
        deviceTtlMs: options.deviceTtlMs
      });
      return {
        principal,
        membership: toMembership(samePrincipal),
        device: recovered.device,
        deviceToken: recovered.deviceToken,
        created: false
      };
    }

    const principal =
      this.getPrincipal(proof.humanPrincipalId) ??
      this.insertPrincipal(proof.humanPrincipalId, proof.displayName);

    const membership = this.insertMembership({
      projectId,
      humanPrincipalId: principal.humanPrincipalId,
      role: "owner"
    });
    const minted = this.insertDevice({
      humanPrincipalId: principal.humanPrincipalId,
      mintedForProjectId: projectId,
      label: options.deviceLabel,
      deviceTtlMs: options.deviceTtlMs
    });

    return {
      principal,
      membership,
      device: minted.device,
      deviceToken: minted.deviceToken,
      created: true
    };
  }

  private createInvitationLocked(input: {
    projectId: string;
    createdByHumanPrincipalId: string;
    ttlMs?: number;
  }): CreateInvitationResult {
    const projectId = humanProjectIdSchema.parse(input.projectId);
    const createdBy = humanPrincipalIdSchema.parse(input.createdByHumanPrincipalId);
    const creatorMembership = this.getActiveMembership(projectId, createdBy);
    if (!creatorMembership || creatorMembership.role !== "owner") {
      throw new HumanIdentityError("human_role_insufficient");
    }

    const openCount = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM project_invitations
         WHERE project_id=? AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at>?`
      )
      .get(projectId, this.clock().toISOString()) as { count: number };
    if (Number(openCount.count) >= HUMAN_MAX_OPEN_INVITATIONS_PER_PROJECT) {
      throw new HumanIdentityError("human_limit_exceeded");
    }

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
      if (isUniqueViolation(error)) {
        throw new HumanIdentityError("human_input_invalid", "Invitation token digest conflict.");
      }
      throw error;
    }

    return {
      invitation: this.getInvitation(invitationId)!,
      invitationToken
    };
  }

  private consumeInvitationLocked(input: {
    invitationToken: string;
    projectId: string;
    displayName: string;
    deviceLabel?: string;
    deviceTtlMs?: number;
    existingDeviceToken?: string;
  }): ConsumeInvitationResult {
    const tokenParsed = projectInvitationTokenSchema.safeParse(input.invitationToken);
    if (!tokenParsed.success) {
      throw new HumanIdentityError("human_invitation_invalid");
    }
    const projectId = humanProjectIdSchema.parse(input.projectId);
    const digest = hashHumanToken(tokenParsed.data);

    const row = this.database
      .prepare("SELECT * FROM project_invitations WHERE token_sha256=?")
      .get(digest) as InvitationRow | undefined;
    if (!row || !digestsEqual(row.token_sha256, digest)) {
      throw new HumanIdentityError("human_invitation_invalid");
    }

    const invitation = toInvitation(row);
    const usability = evaluateInvitationUsability({
      invitation,
      projectId,
      now: this.clock()
    });
    if (!usability.usable) {
      throw new HumanIdentityError(usability.code);
    }

    let principal: HumanPrincipal;
    let principalCreated = false;

    if (input.existingDeviceToken !== undefined) {
      const existingToken = humanDeviceTokenSchema.safeParse(input.existingDeviceToken);
      if (!existingToken.success) {
        // Invalid link proof: do not fall through to create, and do not reveal accounts.
        throw new HumanIdentityError("human_auth_unauthenticated");
      }
      const existingDigest = hashHumanToken(existingToken.data);
      const deviceRow = this.database
        .prepare("SELECT * FROM human_device_credentials WHERE token_sha256=?")
        .get(existingDigest) as DeviceRow | undefined;
      if (!deviceRow || !digestsEqual(deviceRow.token_sha256, existingDigest)) {
        throw new HumanIdentityError("human_auth_unauthenticated");
      }
      const existingDevice = toDevice(deviceRow);
      const existingPrincipal = this.getPrincipal(existingDevice.humanPrincipalId);
      if (!existingPrincipal) {
        throw new HumanIdentityError("human_auth_unauthenticated");
      }
      const deviceUsability = evaluateDeviceUsability({
        device: existingDevice,
        humanPrincipalId: existingPrincipal.humanPrincipalId,
        now: this.clock()
      });
      if (!deviceUsability.usable) {
        throw new HumanIdentityError(deviceUsability.code);
      }
      principal = existingPrincipal;
    } else {
      const displayName = humanDisplayNameSchema.parse(input.displayName);
      principal = this.insertPrincipal(randomUUID(), displayName);
      principalCreated = true;
    }

    const existingMembership = this.getActiveMembership(projectId, principal.humanPrincipalId);
    if (existingMembership) {
      // Already a member: still consume the invite if open, but do not double-join.
      // Reject to keep invitation single-purpose and avoid silent no-ops that could hide bugs.
      throw new HumanIdentityError("human_input_invalid", "Principal is already an active member.");
    }

    if (this.countActiveMembers(projectId) >= HUMAN_MAX_MEMBERS_PER_PROJECT) {
      throw new HumanIdentityError("human_limit_exceeded");
    }

    const membership = this.insertMembership({
      projectId,
      humanPrincipalId: principal.humanPrincipalId,
      role: "member"
    });

    const minted = this.insertDevice({
      humanPrincipalId: principal.humanPrincipalId,
      mintedForProjectId: projectId,
      label: input.deviceLabel,
      deviceTtlMs: input.deviceTtlMs
    });

    const now = this.clock().toISOString();
    const consumed = this.database
      .prepare(
        `UPDATE project_invitations
         SET consumed_at=?, consumed_by_human_principal_id=?
         WHERE invitation_id=? AND consumed_at IS NULL AND revoked_at IS NULL`
      )
      .run(now, principal.humanPrincipalId, invitation.invitationId);
    if (consumed.changes !== 1) {
      throw new HumanIdentityError("human_invitation_consumed");
    }

    return {
      principal,
      membership,
      device: minted.device,
      deviceToken: minted.deviceToken,
      invitation: this.getInvitation(invitation.invitationId)!,
      principalCreated
    };
  }

  private insertPrincipal(humanPrincipalId: string, displayName: string): HumanPrincipal {
    const id = humanPrincipalIdSchema.parse(humanPrincipalId);
    const name = humanDisplayNameSchema.parse(displayName);
    const createdAt = this.clock().toISOString();
    try {
      this.database
        .prepare(
          `INSERT INTO human_principals(human_principal_id,display_name,created_at)
           VALUES (?,?,?)`
        )
        .run(id, name, createdAt);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = this.getPrincipal(id);
        if (existing) return existing;
        throw new HumanIdentityError("human_input_invalid");
      }
      throw error;
    }
    return this.getPrincipal(id)!;
  }

  private insertMembership(input: {
    projectId: string;
    humanPrincipalId: string;
    role: ProjectMemberRole;
  }): ProjectMembership {
    const membershipId = projectMembershipIdSchema.parse(randomUUID());
    const now = this.clock().toISOString();
    try {
      this.database
        .prepare(
          `INSERT INTO project_memberships(
            membership_id,project_id,human_principal_id,role,created_at,updated_at
          ) VALUES (?,?,?,?,?,?)`
        )
        .run(membershipId, input.projectId, input.humanPrincipalId, input.role, now, now);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HumanIdentityError("human_input_invalid", "Active membership already exists.");
      }
      throw error;
    }
    return this.getMembership(membershipId)!;
  }

  private insertDevice(input: {
    humanPrincipalId: string;
    mintedForProjectId: string;
    label?: string;
    deviceTtlMs?: number;
  }): { device: HumanDeviceCredentialMetadata; deviceToken: string } {
    const activeCount = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM human_device_credentials
         WHERE human_principal_id=? AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at>?)`
      )
      .get(input.humanPrincipalId, this.clock().toISOString()) as { count: number };
    if (Number(activeCount.count) >= HUMAN_MAX_DEVICES_PER_PRINCIPAL) {
      throw new HumanIdentityError("human_limit_exceeded");
    }

    const deviceCredentialId = humanDeviceCredentialIdSchema.parse(randomUUID());
    const deviceToken = mintHumanDeviceToken();
    const tokenSha256 = hashHumanToken(deviceToken);
    const createdAt = this.clock().toISOString();
    const label = input.label === undefined ? null : humanDeviceLabelSchema.parse(input.label);
    const expiresAt =
      input.deviceTtlMs === undefined
        ? null
        : new Date(
            this.clock().getTime() + humanDeviceTtlMsSchema.parse(input.deviceTtlMs)
          ).toISOString();

    try {
      this.database
        .prepare(
          `INSERT INTO human_device_credentials(
            device_credential_id,human_principal_id,minted_for_project_id,label,
            token_sha256,created_at,expires_at
          ) VALUES (?,?,?,?,?,?,?)`
        )
        .run(
          deviceCredentialId,
          input.humanPrincipalId,
          input.mintedForProjectId,
          label,
          tokenSha256,
          createdAt,
          expiresAt
        );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HumanIdentityError("human_input_invalid", "Device token digest conflict.");
      }
      throw error;
    }

    return { device: this.getDevice(deviceCredentialId)!, deviceToken };
  }

  /**
   * First non-revoked, non-expired device for the principal, if any.
   * Used by idempotent bootstrap to avoid re-minting when recovery is unnecessary.
   */
  private findUsableDevice(humanPrincipalId: string): HumanDeviceCredentialMetadata | undefined {
    const rows = this.database
      .prepare(
        `SELECT * FROM human_device_credentials
         WHERE human_principal_id=?
         ORDER BY created_at ASC, device_credential_id ASC`
      )
      .all(humanPrincipalId) as DeviceRow[];
    const now = this.clock();
    for (const row of rows) {
      const device = toDevice(row);
      const usability = evaluateDeviceUsability({
        device,
        humanPrincipalId,
        now
      });
      if (usability.usable) return device;
    }
    return undefined;
  }
}

export function isActiveProjectMembership(membership: ProjectMembership): boolean {
  return isActiveMembership(membership);
}
