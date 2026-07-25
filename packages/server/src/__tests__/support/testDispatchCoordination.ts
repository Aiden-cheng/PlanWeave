import {
  DispatchService,
  type DispatchServiceOptions
} from "../../dispatches.js";
import { ArtifactAuthorizationRepository } from "../../artifactAuthorization.js";
import { AgentHostRepository } from "../../hosts.js";
import { DurableMailbox } from "../../mailbox.js";
import type { SqliteDatabase } from "../../sqlite.js";

/**
 * Test-only thin dispatch stack (hosts/mailbox/grants/dispatches).
 * Production composition uses `createRemoteBlockCoordination` exclusively.
 */
export type TestDispatchCoordinationOptions = Omit<DispatchServiceOptions, "writeback"> & {
  writeback: DispatchServiceOptions["writeback"];
};

export function createTestDispatchCoordination(
  database: SqliteDatabase,
  options: TestDispatchCoordinationOptions
) {
  const hosts = new AgentHostRepository(database);
  const mailbox = new DurableMailbox(database);
  const artifactAuthorization = new ArtifactAuthorizationRepository(database);
  const dispatches = new DispatchService(database, hosts, artifactAuthorization, options);
  return { hosts, mailbox, artifactAuthorization, dispatches };
}

export type TestDispatchCoordination = ReturnType<typeof createTestDispatchCoordination>;
