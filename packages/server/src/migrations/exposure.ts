import type { Migration } from "./types.js";

export const exposureLeaseMigration: Migration = {
  version: 43,
  sql: `
CREATE TABLE server_exposure_leases (
  slot TEXT PRIMARY KEY CHECK(slot = 'tailscale_https'),
  lease_id TEXT NOT NULL CHECK(length(lease_id) = 64),
  config_fingerprint TEXT NOT NULL CHECK(length(config_fingerprint) = 64),
  node_identity_sha256 TEXT NOT NULL CHECK(length(node_identity_sha256) = 64),
  advertised_origin TEXT NOT NULL,
  https_port INTEGER NOT NULL CHECK(https_port = 443),
  route_path TEXT NOT NULL CHECK(route_path = '/'),
  backend_origin TEXT NOT NULL,
  serve_config_sha256 TEXT NOT NULL CHECK(length(serve_config_sha256) = 64),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_server_exposure_leases_lease_id
  ON server_exposure_leases(lease_id);
`
};
