import { randomUUID } from "node:crypto";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import { DeviceCredentialStore } from "./deviceCredentialStore.js";
import { HumanIdentityError } from "./errors.js";
import { InvitationStore } from "./invitationStore.js";
import {
  HUMAN_MAX_MEMBERS_PER_PROJECT,
  HUMAN_MAX_OPEN_INVITATIONS_PER_PROJECT
} from "./limits.js";
import { MembershipStore } from "./membershipStore.js";
import {
  evaluateDeviceUsability,
  evaluateInvitationUsability,
  humanDeviceTokenSchema,
  humanDisplayNameSchema,
  humanPrincipalIdSchema,
  humanProjectIdSchema,
  isActiveMembership,
  localAdministrativeProofSchema,
  type HumanDeviceCredentialMetadata,
  type HumanPrincipal,
  type LocalAdministrativeProof,
  type ProjectInvitationMetadata,
  type ProjectMembership
} from "./schemas.js";

export { HumanIdentityError } from "./errors.js";

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

/**
 * SQLite repositories for human principals, project memberships, invitations, and devices.
 * Stores only token digests and safe metadata. Plaintext secrets leave this layer at most once.
 */
export class HumanIdentityRepository {
  private readonly memberships: MembershipStore;
  private readonly devices: DeviceCredentialStore;
  private readonly invitations: InvitationStore;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date()
  ) {
    this.memberships = new MembershipStore(database, clock);
    this.devices = new DeviceCredentialStore(database, clock);
    this.invitations = new InvitationStore(database, clock);
  }

  getPrincipal(humanPrincipalId: string): HumanPrincipal | undefined {
    return this.memberships.getPrincipal(humanPrincipalId);
  }

  getMembership(membershipId: string): ProjectMembership | undefined {
    return this.memberships.getMembership(membershipId);
  }

  getActiveMembership(projectId: string, humanPrincipalId: string): ProjectMembership | undefined {
    return this.memberships.getActiveMembership(projectId, humanPrincipalId);
  }

  countActiveOwners(projectId: string): number {
    return this.memberships.countActiveOwners(projectId);
  }

  countActiveMembers(projectId: string): number {
    return this.memberships.countActiveMembers(projectId);
  }

  listActiveMembers(projectId: string, limit = 100, offset = 0): ProjectMembership[] {
    return this.memberships.listActiveMembers(projectId, limit, offset);
  }

  getInvitation(invitationId: string): ProjectInvitationMetadata | undefined {
    return this.invitations.getInvitation(invitationId);
  }

  /**
   * Lookup invitation metadata by plaintext bearer. Uses constant-time digest compare.
   * Returns undefined for unknown tokens without distinguishing prior validity.
   */
  findInvitationByToken(invitationToken: string): ProjectInvitationMetadata | undefined {
    return this.invitations.findInvitationByToken(invitationToken);
  }

  getDevice(deviceCredentialId: string): HumanDeviceCredentialMetadata | undefined {
    return this.devices.getDevice(deviceCredentialId);
  }

  listDevicesForPrincipal(
    humanPrincipalId: string,
    projectId: string,
    limit = 100,
    offset = 0
  ): HumanDeviceCredentialMetadata[] {
    return this.devices.listDevicesForPrincipal(humanPrincipalId, projectId, limit, offset);
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
    return this.devices.listDevicesForProjectMembers(projectId, limit, offset);
  }

  listInvitations(
    projectId: string,
    limit = 100,
    offset = 0,
    options: { openOnly?: boolean } = {}
  ): ProjectInvitationMetadata[] {
    return this.invitations.listInvitations(projectId, limit, offset, options);
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
    return inWriteTransaction(this.database, () =>
      this.invitations.revokeInvitation(invitationId, projectId)
    );
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
    const device = this.devices.findDeviceByToken(deviceToken);
    if (!device) return undefined;
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

    const refreshed = this.devices.recordLastUsed(device.deviceCredentialId);
    return { principal, device: refreshed, membership };
  }

  revokeDevice(
    deviceCredentialId: string,
    projectId: string,
    ownerHumanPrincipalId?: string
  ): HumanDeviceCredentialMetadata {
    return inWriteTransaction(this.database, () =>
      this.devices.revokeDevice(deviceCredentialId, projectId, ownerHumanPrincipalId)
    );
  }

  /**
   * Soft-revoke membership. Last active owner cannot be removed.
   * Revokes devices minted for this project for the removed principal only.
   * Other projects' memberships and devices are untouched.
   */
  removeMember(projectId: string, targetHumanPrincipalId: string): ProjectMembership {
    return inWriteTransaction(this.database, () => {
      const removed = this.memberships.removeMember(projectId, targetHumanPrincipalId);
      this.devices.revokeProjectDevicesForPrincipal(
        removed.membership.humanPrincipalId,
        removed.membership.projectId,
        removed.revokedAt
      );
      return removed.membership;
    });
  }

  promoteToOwner(projectId: string, targetHumanPrincipalId: string): ProjectMembership {
    return inWriteTransaction(this.database, () =>
      this.memberships.promoteToOwner(projectId, targetHumanPrincipalId)
    );
  }

  demoteOwner(projectId: string, targetHumanPrincipalId: string): ProjectMembership {
    return inWriteTransaction(this.database, () =>
      this.memberships.demoteOwner(projectId, targetHumanPrincipalId)
    );
  }

  private bootstrapOwnerLocked(
    proof: LocalAdministrativeProof,
    options: { deviceLabel?: string; deviceTtlMs?: number }
  ): BootstrapOwnerResult {
    const projectId = proof.projectId;
    const existingOwners = this.memberships.listActiveOwners(projectId);

    const samePrincipal = existingOwners.find(
      (membership) => membership.humanPrincipalId === proof.humanPrincipalId
    );
    if (existingOwners.length > 0 && !samePrincipal) {
      throw new HumanIdentityError("human_bootstrap_conflict");
    }

    if (samePrincipal) {
      const principal =
        this.getPrincipal(proof.humanPrincipalId) ??
        this.memberships.insertPrincipal(proof.humanPrincipalId, proof.displayName);
      const usable = this.devices.findUsableDevice(proof.humanPrincipalId);
      if (usable) {
        return {
          principal,
          membership: samePrincipal,
          device: usable,
          created: false
        };
      }
      // Recovery: owner membership exists but no active usable device remains.
      // Local-admin re-bootstrap mints a one-shot token without creating a second owner.
      const recovered = this.devices.insertDevice({
        humanPrincipalId: principal.humanPrincipalId,
        mintedForProjectId: projectId,
        label: options.deviceLabel,
        deviceTtlMs: options.deviceTtlMs
      });
      return {
        principal,
        membership: samePrincipal,
        device: recovered.device,
        deviceToken: recovered.deviceToken,
        created: false
      };
    }

    const principal =
      this.getPrincipal(proof.humanPrincipalId) ??
      this.memberships.insertPrincipal(proof.humanPrincipalId, proof.displayName);

    const membership = this.memberships.insertMembership({
      projectId,
      humanPrincipalId: principal.humanPrincipalId,
      role: "owner"
    });
    const minted = this.devices.insertDevice({
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

    if (
      this.invitations.countOpenInvitations(projectId) >=
      HUMAN_MAX_OPEN_INVITATIONS_PER_PROJECT
    ) {
      throw new HumanIdentityError("human_limit_exceeded");
    }
    return this.invitations.insertInvitation({
      ...input,
      projectId,
      createdByHumanPrincipalId: createdBy
    });
  }

  private consumeInvitationLocked(input: {
    invitationToken: string;
    projectId: string;
    displayName: string;
    deviceLabel?: string;
    deviceTtlMs?: number;
    existingDeviceToken?: string;
  }): ConsumeInvitationResult {
    const projectId = humanProjectIdSchema.parse(input.projectId);
    const invitation = this.invitations.findInvitationByToken(input.invitationToken);
    if (!invitation) throw new HumanIdentityError("human_invitation_invalid");
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
      const existingDevice = this.devices.findDeviceByToken(existingToken.data);
      if (!existingDevice) throw new HumanIdentityError("human_auth_unauthenticated");
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
      principal = this.memberships.insertPrincipal(randomUUID(), displayName);
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

    const membership = this.memberships.insertMembership({
      projectId,
      humanPrincipalId: principal.humanPrincipalId,
      role: "member"
    });

    const minted = this.devices.insertDevice({
      humanPrincipalId: principal.humanPrincipalId,
      mintedForProjectId: projectId,
      label: input.deviceLabel,
      deviceTtlMs: input.deviceTtlMs
    });

    const consumed = this.invitations.markConsumed(
      invitation.invitationId,
      principal.humanPrincipalId
    );

    return {
      principal,
      membership,
      device: minted.device,
      deviceToken: minted.deviceToken,
      invitation: consumed,
      principalCreated
    };
  }
}

export function isActiveProjectMembership(membership: ProjectMembership): boolean {
  return isActiveMembership(membership);
}
