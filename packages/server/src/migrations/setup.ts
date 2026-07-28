import type { Migration } from "./types.js";

/**
 * OSS-005 B-002: durable one-time setup-code grants and revocation audit.
 *
 * Stores digests only; plaintext codes never persist. Existing Host enrollment
 * grant tables are intentionally untouched so enrollment tokens remain valid.
 * CREATE IF NOT EXISTS keeps the migration retryable without expanding scope.
 */
export const setupCodeMigrationSql = `
CREATE TABLE IF NOT EXISTS setup_code_grants (
  setup_code_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  purpose TEXT NOT NULL CHECK(purpose IN ('device_session','operator_session','host_enrollment')),
  code_sha256 TEXT NOT NULL UNIQUE
    CHECK(length(code_sha256)=64 AND code_sha256 NOT GLOB '*[^a-f0-9]*'),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  displayed_at TEXT,
  redeemed_at TEXT,
  revoked_at TEXT,
  redemption_subject_id TEXT,
  issued_by_operator_id TEXT,
  issued_by_operator_session_id TEXT,
  credential_expires_at TEXT,
  CHECK(expires_at > issued_at),
  CHECK((redeemed_at IS NULL) = (redemption_subject_id IS NULL)),
  CHECK(displayed_at IS NULL OR displayed_at >= issued_at),
  CHECK(redeemed_at IS NULL OR displayed_at IS NOT NULL),
  CHECK(
    purpose <> 'host_enrollment'
    OR credential_expires_at IS NULL
    OR credential_expires_at > expires_at
  )
);

CREATE INDEX IF NOT EXISTS idx_setup_code_grants_workspace_issued
  ON setup_code_grants(workspace_id, issued_at, setup_code_id);

CREATE INDEX IF NOT EXISTS idx_setup_code_grants_workspace_open
  ON setup_code_grants(workspace_id, expires_at)
  WHERE redeemed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS setup_code_revocations (
  revocation_id TEXT PRIMARY KEY,
  setup_code_id TEXT NOT NULL REFERENCES setup_code_grants(setup_code_id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  purpose TEXT NOT NULL CHECK(purpose IN ('device_session','operator_session','host_enrollment')),
  revoked_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 512),
  UNIQUE(setup_code_id)
);

CREATE INDEX IF NOT EXISTS idx_setup_code_revocations_workspace
  ON setup_code_revocations(workspace_id, revoked_at);
`;

export const setupCodeMigration: Migration = {
  version: 31,
  sql: setupCodeMigrationSql
};

/**
 * Durable host setup-code outcome. A response lost after the Server commits an
 * enrollment may be retried only by the exact Host attempt that created it.
 */
export const setupCodeHostEnrollmentOutcomeMigration: Migration = {
  version: 32,
  sql: `
CREATE TABLE IF NOT EXISTS setup_code_host_enrollment_outcomes (
  setup_code_id TEXT PRIMARY KEY REFERENCES setup_code_grants(setup_code_id),
  enrollment_attempt_id TEXT NOT NULL UNIQUE,
  request_sha256 TEXT NOT NULL
    CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^a-f0-9]*'),
  enrollment_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  credential_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`
};
