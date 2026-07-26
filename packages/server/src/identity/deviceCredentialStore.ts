import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../sqlite.js";
import { digestsEqual, hashHumanToken, mintHumanDeviceToken } from "./crypto.js";
import { HumanIdentityError, isHumanIdentityUniqueViolation } from "./errors.js";
import { HUMAN_MAX_DEVICES_PER_PRINCIPAL } from "./limits.js";
import {
  evaluateDeviceUsability,
  humanDeviceCredentialIdSchema,
  humanDeviceCredentialMetadataSchema,
  humanDeviceLabelSchema,
  humanDeviceTokenSchema,
  humanDeviceTtlMsSchema,
  humanPrincipalIdSchema,
  humanProjectIdSchema,
  type HumanDeviceCredentialMetadata
} from "./schemas.js";

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

export class DeviceCredentialStore {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date
  ) {}

  getDevice(deviceCredentialId: string): HumanDeviceCredentialMetadata | undefined {
    const id = humanDeviceCredentialIdSchema.parse(deviceCredentialId);
    const row = this.database
      .prepare("SELECT * FROM human_device_credentials WHERE device_credential_id=?")
      .get(id) as DeviceRow | undefined;
    return row ? toDevice(row) : undefined;
  }

  findDeviceByToken(deviceToken: string): HumanDeviceCredentialMetadata | undefined {
    const token = humanDeviceTokenSchema.safeParse(deviceToken);
    if (!token.success) return undefined;
    const digest = hashHumanToken(token.data);
    const row = this.database
      .prepare("SELECT * FROM human_device_credentials WHERE token_sha256=?")
      .get(digest) as DeviceRow | undefined;
    if (!row || !digestsEqual(row.token_sha256, digest)) return undefined;
    return toDevice(row);
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

  recordLastUsed(deviceCredentialId: string): HumanDeviceCredentialMetadata {
    const id = humanDeviceCredentialIdSchema.parse(deviceCredentialId);
    this.database
      .prepare(
        `UPDATE human_device_credentials SET last_used_at=?
         WHERE device_credential_id=? AND revoked_at IS NULL`
      )
      .run(this.clock().toISOString(), id);
    return this.getDevice(id)!;
  }

  revokeDevice(
    deviceCredentialId: string,
    projectId: string,
    ownerHumanPrincipalId?: string
  ): HumanDeviceCredentialMetadata {
    const id = humanDeviceCredentialIdSchema.parse(deviceCredentialId);
    const pid = humanProjectIdSchema.parse(projectId);
    const device = this.getDevice(id);
    if (!device) throw new HumanIdentityError("human_input_invalid");
    if (device.mintedForProjectId !== pid) {
      throw new HumanIdentityError("human_cross_project_forbidden");
    }
    if (
      ownerHumanPrincipalId !== undefined &&
      device.humanPrincipalId !== humanPrincipalIdSchema.parse(ownerHumanPrincipalId)
    ) {
      throw new HumanIdentityError("human_device_not_owner");
    }
    if (device.revokedAt) throw new HumanIdentityError("human_device_revoked");
    const updated = this.database
      .prepare(
        `UPDATE human_device_credentials SET revoked_at=?
         WHERE device_credential_id=? AND minted_for_project_id=? AND revoked_at IS NULL`
      )
      .run(this.clock().toISOString(), id, pid);
    if (updated.changes !== 1) throw new HumanIdentityError("human_device_revoked");
    return this.getDevice(id)!;
  }

  revokeProjectDevicesForPrincipal(
    humanPrincipalId: string,
    projectId: string,
    revokedAt: string
  ): void {
    const hid = humanPrincipalIdSchema.parse(humanPrincipalId);
    const pid = humanProjectIdSchema.parse(projectId);
    this.database
      .prepare(
        `UPDATE human_device_credentials SET revoked_at=?
         WHERE human_principal_id=? AND minted_for_project_id=? AND revoked_at IS NULL`
      )
      .run(revokedAt, hid, pid);
  }

  insertDevice(input: {
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
      if (isHumanIdentityUniqueViolation(error)) {
        throw new HumanIdentityError("human_input_invalid", "Device token digest conflict.");
      }
      throw error;
    }

    return { device: this.getDevice(deviceCredentialId)!, deviceToken };
  }

  findUsableDevice(humanPrincipalId: string): HumanDeviceCredentialMetadata | undefined {
    const hid = humanPrincipalIdSchema.parse(humanPrincipalId);
    const rows = this.database
      .prepare(
        `SELECT * FROM human_device_credentials
         WHERE human_principal_id=?
         ORDER BY created_at ASC, device_credential_id ASC`
      )
      .all(hid) as DeviceRow[];
    const now = this.clock();
    for (const row of rows) {
      const device = toDevice(row);
      const usability = evaluateDeviceUsability({ device, humanPrincipalId: hid, now });
      if (usability.usable) return device;
    }
    return undefined;
  }
}
