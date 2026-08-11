import {
  HOST_CREDENTIAL_PREVIOUS_TOKEN_GRACE_MS,
  hostCredentialPolicySchema,
  hostCredentialTokenSchema,
  type HostCredentialPolicy,
  type HostCredentialRotationResponse
} from "@planweave-ai/agent-host-protocol";
import { createHash, timingSafeEqual } from "node:crypto";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";

type CredentialRow = {
  id: string;
  credential_hash: string;
  credential_expires_at: string | null;
  credential_lifetime_days: number | null;
  credential_renewal_requested_at: string | null;
  previous_credential_hash: string | null;
  previous_credential_grace_expires_at: string | null;
  revoked_at: string | null;
};

type RotationRow = {
  host_id: string;
  rotation_id: string;
  credential_hash: string;
  credential_expires_at: string;
  created_at: string;
};

export type HostCredentialAuthenticationKind = "current" | "promoted" | "previous";

export type HostCredentialRenewalState = {
  hostId: string;
  credentialExpiresAt: string;
  policy: HostCredentialPolicy;
  renewalRequestedAt?: string;
};

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function tokenMatches(expectedHex: string | null, tokenHash: Buffer): boolean {
  if (!expectedHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  return expected.length === tokenHash.length && timingSafeEqual(expected, tokenHash);
}

function policyFor(row: CredentialRow): HostCredentialPolicy | undefined {
  if (row.credential_lifetime_days === null) return undefined;
  return hostCredentialPolicySchema.parse({
    lifetimeDays: row.credential_lifetime_days,
    renewal: "automatic"
  });
}

export class HostCredentialLifecycleRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date()
  ) {}

  authenticate(hostId: string, token: string): HostCredentialAuthenticationKind | undefined {
    const parsedToken = hostCredentialTokenSchema.safeParse(token);
    if (!parsedToken.success) return undefined;
    const tokenHash = hashToken(parsedToken.data);
    const now = this.clock();
    const row = this.row(hostId);
    if (!row || row.revoked_at) return undefined;

    if (
      (row.credential_expires_at === null ||
        Date.parse(row.credential_expires_at) > now.getTime()) &&
      tokenMatches(row.credential_hash, tokenHash)
    ) {
      return "current";
    }

    const rotation = this.rotation(hostId);
    if (
      rotation &&
      Date.parse(rotation.credential_expires_at) > now.getTime() &&
      tokenMatches(rotation.credential_hash, tokenHash)
    ) {
      inWriteTransaction(this.database, () => {
        const current = this.row(hostId);
        const pending = this.rotation(hostId);
        if (
          !current ||
          current.revoked_at ||
          !pending ||
          pending.rotation_id !== rotation.rotation_id
        ) {
          throw new Error("agent_host_credential_rotation_conflict");
        }
        this.database
          .prepare(
            `UPDATE agent_hosts
             SET previous_credential_hash=credential_hash,
                 previous_credential_grace_expires_at=?,
                 credential_hash=?,credential_expires_at=?,credential_renewal_requested_at=NULL
             WHERE id=?`
          )
          .run(
            new Date(now.getTime() + HOST_CREDENTIAL_PREVIOUS_TOKEN_GRACE_MS).toISOString(),
            pending.credential_hash,
            pending.credential_expires_at,
            hostId
          );
        this.database
          .prepare("DELETE FROM agent_host_credential_rotations WHERE host_id=?")
          .run(hostId);
      });
      return "promoted";
    }

    if (
      row.previous_credential_grace_expires_at &&
      Date.parse(row.previous_credential_grace_expires_at) > now.getTime() &&
      tokenMatches(row.previous_credential_hash, tokenHash)
    ) {
      return "previous";
    }
    return undefined;
  }

  renewalState(hostId: string): HostCredentialRenewalState {
    const row = this.requireRenewable(hostId);
    return {
      hostId,
      credentialExpiresAt: row.credential_expires_at!,
      policy: policyFor(row)!,
      ...(row.credential_renewal_requested_at
        ? { renewalRequestedAt: row.credential_renewal_requested_at }
        : {})
    };
  }

  requestRenewal(hostId: string): HostCredentialRenewalState {
    const row = this.requireRenewable(hostId);
    const requestedAt = row.credential_renewal_requested_at ?? this.clock().toISOString();
    this.database
      .prepare(
        `UPDATE agent_hosts SET credential_renewal_requested_at=?
         WHERE id=? AND credential_renewal_requested_at IS NULL`
      )
      .run(requestedAt, hostId);
    return this.renewalState(hostId);
  }

  registerRotation(
    hostId: string,
    rotationId: string,
    nextCredentialToken: string
  ): HostCredentialRotationResponse {
    const token = hostCredentialTokenSchema.parse(nextCredentialToken);
    return inWriteTransaction(this.database, () => {
      const row = this.requireRenewable(hostId);
      const nextHash = hashToken(token).toString("hex");
      const existing = this.rotation(hostId);
      if (existing) {
        if (existing.rotation_id !== rotationId || existing.credential_hash !== nextHash) {
          throw new Error("agent_host_credential_rotation_conflict");
        }
        return {
          hostId,
          rotationId,
          credentialExpiresAt: existing.credential_expires_at
        };
      }
      const now = this.clock();
      const policy = policyFor(row)!;
      const credentialExpiresAt = new Date(
        now.getTime() + policy.lifetimeDays * 24 * 60 * 60_000
      ).toISOString();
      this.database
        .prepare(
          `INSERT INTO agent_host_credential_rotations(
             host_id,rotation_id,credential_hash,credential_expires_at,created_at
           ) VALUES(?,?,?,?,?)`
        )
        .run(hostId, rotationId, nextHash, credentialExpiresAt, now.toISOString());
      return { hostId, rotationId, credentialExpiresAt };
    });
  }

  private requireRenewable(hostId: string): CredentialRow {
    const row = this.row(hostId);
    const now = this.clock().getTime();
    if (!row || row.revoked_at) throw new Error("agent_host_not_found_or_revoked");
    if (!policyFor(row)) throw new Error("agent_host_credential_renewal_not_configured");
    if (!row.credential_expires_at || Date.parse(row.credential_expires_at) <= now) {
      throw new Error("agent_host_credential_expired");
    }
    return row;
  }

  private row(hostId: string): CredentialRow | undefined {
    return this.database
      .prepare(
        `SELECT id,credential_hash,credential_expires_at,credential_lifetime_days,
                credential_renewal_requested_at,previous_credential_hash,
                previous_credential_grace_expires_at,revoked_at
         FROM agent_hosts WHERE id=?`
      )
      .get(hostId) as CredentialRow | undefined;
  }

  private rotation(hostId: string): RotationRow | undefined {
    return this.database
      .prepare("SELECT * FROM agent_host_credential_rotations WHERE host_id=?")
      .get(hostId) as RotationRow | undefined;
  }
}
