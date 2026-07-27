import { hostCredentialTokenSchema } from "@planweave-ai/distributed-protocol";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WorkspaceIdentityRepository } from "./identity/workspaceRepository.js";
import { capabilitiesSchema } from "./protocol.js";
import type { SqliteDatabase } from "./sqlite.js";

export type AgentHost = {
  id: string;
  displayName: string;
  capabilities: string[];
  capacity: number;
  lastSeenAt?: string;
  lastAcknowledgedSequence: number;
  revokedAt?: string;
  credentialExpiresAt?: string;
};

export type RegisteredAgentHost = {
  host: AgentHost;
  token: string;
};

export const DEFAULT_HOST_OFFLINE_AFTER_MS = 60_000;

/** Server-authoritative Host liveness shared by assignment and operator projections. */
export function isAgentHostOnline(
  host: AgentHost,
  options: { now?: Date; hostOfflineAfterMs?: number } = {}
): boolean {
  const now = (options.now ?? new Date()).getTime();
  const hostOfflineAfterMs = options.hostOfflineAfterMs ?? DEFAULT_HOST_OFFLINE_AFTER_MS;
  if (!Number.isFinite(hostOfflineAfterMs) || hostOfflineAfterMs <= 0) {
    throw new Error("host_offline_after_invalid");
  }
  return (
    host.revokedAt === undefined &&
    (host.credentialExpiresAt === undefined || Date.parse(host.credentialExpiresAt) > now) &&
    host.lastSeenAt !== undefined &&
    Date.parse(host.lastSeenAt) >= now - hostOfflineAfterMs
  );
}

type HostRow = Record<string, unknown> & {
  id: string;
  display_name: string;
  credential_hash: string;
  capabilities_json: string;
  capacity: number;
  last_seen_at: string | null;
  last_acknowledged_sequence: number;
  revoked_at: string | null;
  credential_expires_at: string | null;
};

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function toHost(row: HostRow): AgentHost {
  return {
    id: row.id,
    displayName: row.display_name,
    capabilities: capabilitiesSchema.parse(JSON.parse(row.capabilities_json)),
    capacity: Number(row.capacity),
    lastSeenAt: row.last_seen_at ?? undefined,
    lastAcknowledgedSequence: Number(row.last_acknowledged_sequence),
    revokedAt: row.revoked_at ?? undefined,
    credentialExpiresAt: row.credential_expires_at ?? undefined
  };
}

export class AgentHostRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date()
  ) {
    this.workspaceIdentity = new WorkspaceIdentityRepository(database);
  }

  private readonly workspaceIdentity: WorkspaceIdentityRepository;

  private syncWorkspaceHost(hostId: string): void {
    this.workspaceIdentity.synchronizeHost(hostId);
  }

  /** Explicitly authorize a Host for one workspace. */
  bindToWorkspace(hostId: string, workspaceId: string): void {
    this.workspaceIdentity.bindHostToWorkspace(hostId, workspaceId);
  }

  workspaceForLegacyProject(projectId: string): string | undefined {
    return this.workspaceIdentity.workspaceForLegacyProject(projectId);
  }

  register(displayName: string): RegisteredAgentHost {
    const token = `pw_host_${randomBytes(32).toString("base64url")}`;
    return this.registerWithCredential(displayName, token, [], 1);
  }

  registerWithCredential(
    displayName: string,
    token: string,
    capabilities: readonly string[],
    capacity: number,
    credentialExpiresAt?: string
  ): RegisteredAgentHost {
    const parsedToken = hostCredentialTokenSchema.parse(token);
    const parsedCapabilities = capabilitiesSchema.parse(capabilities);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 128) {
      throw new Error("agent_host_capacity_invalid");
    }
    if (
      credentialExpiresAt !== undefined &&
      (!Number.isFinite(Date.parse(credentialExpiresAt)) ||
        Date.parse(credentialExpiresAt) <= this.clock().getTime())
    ) {
      throw new Error("agent_host_credential_expiry_invalid");
    }
    const normalizedName = displayName.trim();
    if (!normalizedName || normalizedName.length > 128) {
      throw new Error("Host display name must contain between 1 and 128 characters.");
    }
    const id = randomUUID();
    const createdAt = this.clock().toISOString();
    this.database
      .prepare(
        "INSERT INTO agent_hosts(id,display_name,credential_hash,capabilities_json,capacity,credential_expires_at,created_at) VALUES (?,?,?,?,?,?,?)"
      )
      .run(
        id,
        normalizedName,
        hashToken(parsedToken).toString("hex"),
        JSON.stringify(parsedCapabilities),
        capacity,
        credentialExpiresAt ?? null,
        createdAt
      );
    const host = this.getRequired(id);
    this.syncWorkspaceHost(id);
    return { host, token: parsedToken };
  }

  get(hostId: string): AgentHost | undefined {
    const row = this.database.prepare("SELECT * FROM agent_hosts WHERE id=?").get(hostId) as
      | HostRow
      | undefined;
    return row ? toHost(row) : undefined;
  }

  getRequired(hostId: string): AgentHost {
    const host = this.get(hostId);
    if (!host) throw new Error("agent_host_not_found");
    return host;
  }

  list(limit = 100, offset = 0): AgentHost[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101) {
      throw new Error("agent_host_list_limit_invalid");
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("agent_host_list_offset_invalid");
    }
    return (
      this.database
        .prepare("SELECT * FROM agent_hosts ORDER BY display_name,id LIMIT ? OFFSET ?")
        .all(limit, offset) as HostRow[]
    ).map(toHost);
  }

  authenticate(hostId: string, token: string, workspaceId?: string): AgentHost | undefined {
    const row = this.database.prepare("SELECT * FROM agent_hosts WHERE id=?").get(hostId) as
      | HostRow
      | undefined;
    if (
      !row ||
      row.revoked_at ||
      (row.credential_expires_at && Date.parse(row.credential_expires_at) <= this.clock().getTime())
    )
      return undefined;
    if (!this.workspaceIdentity.hostUsable(hostId, this.clock(), workspaceId)) return undefined;
    const expected = Buffer.from(row.credential_hash, "hex");
    const actual = hashToken(token);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
    return toHost(row);
  }

  reportOnline(hostId: string, capabilities: readonly string[], capacity: number): AgentHost {
    const parsedCapabilities = capabilitiesSchema.parse(capabilities);
    const now = this.clock().toISOString();
    const updated = this.database
      .prepare(
        `UPDATE agent_hosts SET capabilities_json=?,capacity=?,last_seen_at=?
         WHERE id=? AND revoked_at IS NULL
           AND (credential_expires_at IS NULL OR credential_expires_at>?)`
      )
      .run(JSON.stringify(parsedCapabilities), capacity, now, hostId, now);
    if (updated.changes !== 1) throw new Error("agent_host_not_found_or_revoked");
    const host = this.getRequired(hostId);
    this.syncWorkspaceHost(hostId);
    return host;
  }

  touch(hostId: string, at = new Date()): void {
    const updated = this.database
      .prepare(
        `UPDATE agent_hosts SET last_seen_at=?
         WHERE id=? AND revoked_at IS NULL
           AND (credential_expires_at IS NULL OR credential_expires_at>?)`
      )
      .run(at.toISOString(), hostId, this.clock().toISOString());
    if (updated.changes !== 1) throw new Error("agent_host_not_found_or_revoked");
    const host = this.getRequired(hostId);
    this.syncWorkspaceHost(hostId);
  }

  revoke(hostId: string): void {
    const updated = this.database
      .prepare("UPDATE agent_hosts SET revoked_at=? WHERE id=? AND revoked_at IS NULL")
      .run(this.clock().toISOString(), hostId);
    if (updated.changes !== 1) throw new Error("agent_host_not_found_or_revoked");
    const host = this.getRequired(hostId);
    this.syncWorkspaceHost(hostId);
  }

  listAvailable(
    requiredCapabilities: readonly string[],
    onlineAfter: Date
  ): Array<AgentHost & { activeDispatches: number }> {
    const required = new Set(capabilitiesSchema.parse(requiredCapabilities));
    const rows = this.database
      .prepare(
        `SELECT h.*,
          (SELECT COUNT(*) FROM dispatches d
            WHERE d.host_id=h.id AND d.status IN ('leased','running','cancelling','awaiting_writeback')) AS active_dispatches
         FROM agent_hosts h
         WHERE h.revoked_at IS NULL AND h.last_seen_at >= ?
           AND (h.credential_expires_at IS NULL OR h.credential_expires_at>?)
         ORDER BY active_dispatches ASC, h.last_seen_at DESC, h.id ASC`
      )
      .all(onlineAfter.toISOString(), this.clock().toISOString()) as Array<
      HostRow & { active_dispatches: number }
    >;
    return rows
      .map((row) => ({ ...toHost(row), activeDispatches: Number(row.active_dispatches) }))
      .filter(
        (host) =>
          host.activeDispatches < host.capacity &&
          [...required].every((capability) => host.capabilities.includes(capability))
      );
  }
}
