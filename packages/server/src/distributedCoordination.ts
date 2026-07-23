import {
  DispatchService,
  type DispatchServiceOptions,
  type DispatchWriteback
} from "./dispatches.js";
import { ArtifactAuthorizationRepository } from "./artifactAuthorization.js";
import { AgentHostRepository } from "./hosts.js";
import { DurableMailbox } from "./mailbox.js";
import type { SqliteDatabase } from "./sqlite.js";

export type DistributedCoordinationOptions = Omit<DispatchServiceOptions, "writeback"> & {
  writeback: DispatchWriteback;
};

export function createDistributedCoordination(
  database: SqliteDatabase,
  options: DistributedCoordinationOptions
) {
  const hosts = new AgentHostRepository(database);
  const mailbox = new DurableMailbox(database);
  const artifactAuthorization = new ArtifactAuthorizationRepository(database);
  const dispatches = new DispatchService(database, hosts, mailbox, artifactAuthorization, options);
  return { hosts, mailbox, artifactAuthorization, dispatches };
}
