import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { z } from "zod";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";

const ownershipRowSchema = z
  .object({
    owner_token: z.string().uuid(),
    process_id: z.number().int().positive(),
    hostname: z.string().min(1),
    acquired_at: z.iso.datetime()
  })
  .strict();

export type ServerInstanceOwnership = {
  ownerToken: string;
  processId: number;
  hostname: string;
  acquiredAt: string;
};

function readOwnership(database: SqliteDatabase): ServerInstanceOwnership | undefined {
  const row = database
    .prepare(
      `SELECT owner_token,process_id,hostname,acquired_at
       FROM server_instance_ownership WHERE singleton=1`
    )
    .get();
  if (!row) return undefined;
  const parsed = ownershipRowSchema.parse(row);
  return {
    ownerToken: parsed.owner_token,
    processId: parsed.process_id,
    hostname: parsed.hostname,
    acquiredAt: parsed.acquired_at
  };
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw new Error("server_instance_liveness_check_failed", { cause: error });
  }
}

export function acquireServerInstanceOwnership(
  database: SqliteDatabase,
  now: Date = new Date()
): ServerInstanceOwnership {
  const candidate = {
    ownerToken: randomUUID(),
    processId: process.pid,
    hostname: hostname(),
    acquiredAt: now.toISOString()
  };
  return inWriteTransaction(database, () => {
    const observed = readOwnership(database);
    if (!observed) {
      database
        .prepare(
          `INSERT INTO server_instance_ownership(
             singleton,owner_token,process_id,hostname,acquired_at
           ) VALUES (1,?,?,?,?)`
        )
        .run(candidate.ownerToken, candidate.processId, candidate.hostname, candidate.acquiredAt);
      return candidate;
    }
    if (observed.hostname !== candidate.hostname) {
      throw new Error("server_database_owned_by_remote_host");
    }
    if (processIsAlive(observed.processId)) {
      throw new Error("server_database_already_active");
    }
    const takeover = database
      .prepare(
        `UPDATE server_instance_ownership
         SET owner_token=?,process_id=?,hostname=?,acquired_at=?
         WHERE singleton=1 AND owner_token=?`
      )
      .run(
        candidate.ownerToken,
        candidate.processId,
        candidate.hostname,
        candidate.acquiredAt,
        observed.ownerToken
      );
    if (takeover.changes !== 1) throw new Error("server_instance_ownership_conflict");
    return candidate;
  });
}

export function assertServerInstanceOwnership(database: SqliteDatabase, ownerToken: string): void {
  const parsedToken = z.string().uuid().parse(ownerToken);
  const current = readOwnership(database);
  if (!current || current.ownerToken !== parsedToken) {
    throw new Error("server_instance_ownership_lost");
  }
}

export function releaseServerInstanceOwnership(database: SqliteDatabase, ownerToken: string): void {
  const parsedToken = z.string().uuid().parse(ownerToken);
  const released = database
    .prepare("DELETE FROM server_instance_ownership WHERE singleton=1 AND owner_token=?")
    .run(parsedToken);
  if (released.changes !== 1) throw new Error("server_instance_ownership_lost");
}
