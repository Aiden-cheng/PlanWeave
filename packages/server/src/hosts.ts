import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
};

export type RegisteredAgentHost = {
  host: AgentHost;
  token: string;
};

type HostRow = Record<string, unknown> & {
  id: string;
  display_name: string;
  credential_hash: string;
  capabilities_json: string;
  capacity: number;
  last_seen_at: string | null;
  last_acknowledged_sequence: number;
  revoked_at: string | null;
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
    revokedAt: row.revoked_at ?? undefined
  };
}

export class AgentHostRepository {
  constructor(private readonly database: SqliteDatabase) {}

  register(displayName: string): RegisteredAgentHost {
    const normalizedName = displayName.trim();
    if (!normalizedName || normalizedName.length > 128) {
      throw new Error("Host display name must contain between 1 and 128 characters.");
    }
    const id = randomUUID();
    const token = `pw_host_${randomBytes(32).toString("base64url")}`;
    const createdAt = new Date().toISOString();
    this.database
      .prepare(
        "INSERT INTO agent_hosts(id,display_name,credential_hash,capabilities_json,capacity,created_at) VALUES (?,?,?,?,?,?)"
      )
      .run(id, normalizedName, hashToken(token).toString("hex"), "[]", 1, createdAt);
    return { host: this.getRequired(id), token };
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

  authenticate(hostId: string, token: string): AgentHost | undefined {
    const row = this.database.prepare("SELECT * FROM agent_hosts WHERE id=?").get(hostId) as
      | HostRow
      | undefined;
    if (!row || row.revoked_at) return undefined;
    const expected = Buffer.from(row.credential_hash, "hex");
    const actual = hashToken(token);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
    return toHost(row);
  }

  reportOnline(hostId: string, capabilities: readonly string[], capacity: number): AgentHost {
    const parsedCapabilities = capabilitiesSchema.parse(capabilities);
    const updated = this.database
      .prepare(
        "UPDATE agent_hosts SET capabilities_json=?,capacity=?,last_seen_at=? WHERE id=? AND revoked_at IS NULL"
      )
      .run(JSON.stringify(parsedCapabilities), capacity, new Date().toISOString(), hostId);
    if (updated.changes !== 1) throw new Error("agent_host_not_found_or_revoked");
    return this.getRequired(hostId);
  }

  touch(hostId: string, at = new Date()): void {
    const updated = this.database
      .prepare("UPDATE agent_hosts SET last_seen_at=? WHERE id=? AND revoked_at IS NULL")
      .run(at.toISOString(), hostId);
    if (updated.changes !== 1) throw new Error("agent_host_not_found_or_revoked");
  }

  revoke(hostId: string): void {
    const updated = this.database
      .prepare("UPDATE agent_hosts SET revoked_at=? WHERE id=? AND revoked_at IS NULL")
      .run(new Date().toISOString(), hostId);
    if (updated.changes !== 1) throw new Error("agent_host_not_found_or_revoked");
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
         ORDER BY active_dispatches ASC, h.last_seen_at DESC, h.id ASC`
      )
      .all(onlineAfter.toISOString()) as Array<HostRow & { active_dispatches: number }>;
    return rows
      .map((row) => ({ ...toHost(row), activeDispatches: Number(row.active_dispatches) }))
      .filter(
        (host) =>
          host.activeDispatches < host.capacity &&
          [...required].every((capability) => host.capabilities.includes(capability))
      );
  }
}
