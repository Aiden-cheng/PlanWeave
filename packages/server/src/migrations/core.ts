import {
  migration1,
  migration2,
  migration3,
  migration4,
  migration5,
  migration6,
  migration7,
  migration9,
  migration10,
  migration11,
  migration12,
  migration13,
  migration14,
  migration15,
  migration16
} from "./identityLegacy.js";
import {
  backfillMailboxPredecessors,
  migration8,
  validateAgentHostsForReservations,
  validateArtifactLinkGrantTuples,
  validateArtifactMediaTypes,
  validateRemoteAttemptIdentities
} from "./legacyTail.js";
import type { MigrationModule } from "./types.js";

export const coreMigrations: MigrationModule = {
  name: "core",
  migrations: [
    { version: 1, sql: migration1 },
    { version: 2, sql: migration2 },
    { version: 3, sql: migration3 },
    { version: 4, sql: migration4 },
    { version: 5, sql: migration5, disableForeignKeys: true },
    { version: 6, sql: migration6, after: validateArtifactMediaTypes },
    {
      version: 7,
      sql: migration7,
      before(database) {
        validateArtifactMediaTypes(database);
        validateArtifactLinkGrantTuples(database);
      }
    },
    { version: 8, sql: migration8, before: validateArtifactMediaTypes },
    { version: 9, sql: migration9 },
    { version: 10, sql: migration10, before: validateAgentHostsForReservations },
    { version: 11, sql: migration11 },
    { version: 12, sql: migration12, after: backfillMailboxPredecessors },
    { version: 13, sql: migration13, disableForeignKeys: true },
    { version: 14, sql: migration14 },
    { version: 15, sql: migration15, before: validateRemoteAttemptIdentities },
    { version: 16, sql: migration16 }
  ]
};
