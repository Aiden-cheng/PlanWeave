import { collaborationMigrations } from "./collaboration.js";
import { coreMigrations } from "./core.js";
import { identityMigrations } from "./identity.js";
import { migration26 } from "./legacyTail.js";
import type { Migration, MigrationModule } from "./types.js";

const identityModule: MigrationModule = { name: "identity", migrations: identityMigrations };

const observerMigrations: MigrationModule = {
  name: "observer",
  migrations: [{ version: 26, sql: migration26 }]
};

export const migrationModules: readonly MigrationModule[] = [
  coreMigrations,
  collaborationMigrations,
  observerMigrations,
  identityModule
];

const flattened = migrationModules.flatMap((module) => module.migrations);
const duplicateVersions = flattened
  .map((migration) => migration.version)
  .filter((version, index, versions) => versions.indexOf(version) !== index);
if (duplicateVersions.length > 0) {
  throw new Error(`duplicate_migration_version:${[...new Set(duplicateVersions)].join(",")}`);
}

export const migrations: readonly Migration[] = [...flattened].sort(
  (left, right) => left.version - right.version
);
