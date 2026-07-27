import {
  migration17,
  migration18,
  migration19,
  migration20,
  ensureRemoteActionRejectionState,
  ensureServerInstanceAndRemoteActionClaims
} from "./collaborationLegacy.js";
import {
  dropDispatchPackageRefColumn,
  ensureActivityRetentionIndexes,
  ensureHostSelectionColumn,
  ensureMembershipRevision
} from "./legacyTail.js";
import type { MigrationModule } from "./types.js";

export const collaborationMigrations: MigrationModule = {
  name: "collaboration",
  migrations: [
    { version: 17, sql: migration17 },
    { version: 18, sql: migration18, after: ensureHostSelectionColumn },
    { version: 19, sql: migration19 },
    { version: 20, sql: migration20 },
    { version: 21, sql: "SELECT 1;", after: dropDispatchPackageRefColumn },
    {
      version: 22,
      sql: "SELECT 1;",
      disableForeignKeys: true,
      after: ensureRemoteActionRejectionState
    },
    { version: 23, sql: "SELECT 1;", after: ensureServerInstanceAndRemoteActionClaims },
    { version: 24, sql: "SELECT 1;", after: ensureMembershipRevision },
    { version: 25, sql: "SELECT 1;", after: ensureActivityRetentionIndexes }
  ]
};
