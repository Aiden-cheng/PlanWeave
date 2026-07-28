import { collaborationMigrations } from "./collaboration.js";
import { coreMigrations } from "./core.js";
import { identityMigrations } from "./identity.js";
import { migration26 } from "./legacyTail.js";
import { aclRegistryMigration } from "./aclRegistry.js";
import { assignmentAuthorityMigration } from "./assignment.js";
import { canvasCommandMigration } from "./canvas.js";
import { contentVersionMigration } from "./contentVersions.js";
import { setupCodeHostEnrollmentOutcomeMigration, setupCodeMigration } from "./setup.js";
import { commentWorkspaceScopeMigration } from "./commentWorkspaceScope.js";
import { hostReadinessMigration } from "./hostReadiness.js";
import { assignmentWorkspaceScopeMigration } from "./assignmentWorkspaceScope.js";
import { observerWorkspaceScopeMigration } from "./observerWorkspaceScope.js";
import { attachmentWorkspaceScopeMigration } from "./attachmentWorkspaceScope.js";
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
  identityModule,
  { name: "acl-registry", migrations: [aclRegistryMigration] },
  { name: "assignment-authority", migrations: [assignmentAuthorityMigration] },
  { name: "canvas-command", migrations: [canvasCommandMigration] },
  { name: "content-versions", migrations: [contentVersionMigration] },
  { name: "setup-code", migrations: [setupCodeMigration, setupCodeHostEnrollmentOutcomeMigration] },
  { name: "comment-workspace-scope", migrations: [commentWorkspaceScopeMigration] },
  { name: "host-readiness", migrations: [hostReadinessMigration] },
  { name: "assignment-workspace-scope", migrations: [assignmentWorkspaceScopeMigration] },
  { name: "observer-workspace-scope", migrations: [observerWorkspaceScopeMigration] },
  { name: "attachment-workspace-scope", migrations: [attachmentWorkspaceScopeMigration] }
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
