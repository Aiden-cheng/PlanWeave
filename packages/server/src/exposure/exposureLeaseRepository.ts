import type { SqliteDatabase } from "../sqlite.js";
import { tailscaleServeLeaseSchema, type ExposureLeaseStorePort } from "./types.js";

export class SqliteExposureLeaseStore implements ExposureLeaseStorePort {
  constructor(private readonly database: SqliteDatabase) {}

  load() {
    const row = this.database
      .prepare(
        `SELECT lease_id,config_fingerprint,node_identity_sha256,advertised_origin,
                https_port,route_path,backend_origin,serve_config_sha256,created_at
         FROM server_exposure_leases WHERE slot='tailscale_https'`
      )
      .get();
    if (!row) return null;
    return tailscaleServeLeaseSchema.parse({
      leaseId: row.lease_id,
      configFingerprint: row.config_fingerprint,
      nodeIdentitySha256: row.node_identity_sha256,
      advertisedOrigin: row.advertised_origin,
      httpsPort: row.https_port,
      path: row.route_path,
      backendOrigin: row.backend_origin,
      serveConfigSha256: row.serve_config_sha256,
      createdAt: row.created_at
    });
  }

  insertIfAbsent(rawLease: Parameters<ExposureLeaseStorePort["insertIfAbsent"]>[0]): boolean {
    const lease = tailscaleServeLeaseSchema.parse(rawLease);
    const result = this.database
      .prepare(
        `INSERT INTO server_exposure_leases(
           slot,lease_id,config_fingerprint,node_identity_sha256,advertised_origin,
           https_port,route_path,backend_origin,serve_config_sha256,created_at
         ) VALUES('tailscale_https',?,?,?,?,?,?,?,?,?)
         ON CONFLICT(slot) DO NOTHING`
      )
      .run(
        lease.leaseId,
        lease.configFingerprint,
        lease.nodeIdentitySha256,
        lease.advertisedOrigin,
        lease.httpsPort,
        lease.path,
        lease.backendOrigin,
        lease.serveConfigSha256,
        lease.createdAt
      );
    return result.changes === 1;
  }

  replaceExact(
    rawExpected: Parameters<ExposureLeaseStorePort["replaceExact"]>[0],
    rawReplacement: Parameters<ExposureLeaseStorePort["replaceExact"]>[1]
  ): boolean {
    const expected = tailscaleServeLeaseSchema.parse(rawExpected);
    const replacement = tailscaleServeLeaseSchema.parse(rawReplacement);
    const result = this.database
      .prepare(
        `UPDATE server_exposure_leases SET
           lease_id=?,config_fingerprint=?,node_identity_sha256=?,advertised_origin=?,
           https_port=?,route_path=?,backend_origin=?,serve_config_sha256=?,created_at=?
         WHERE slot='tailscale_https' AND lease_id=? AND config_fingerprint=?
           AND node_identity_sha256=? AND advertised_origin=? AND https_port=?
           AND route_path=? AND backend_origin=? AND serve_config_sha256=? AND created_at=?`
      )
      .run(
        replacement.leaseId,
        replacement.configFingerprint,
        replacement.nodeIdentitySha256,
        replacement.advertisedOrigin,
        replacement.httpsPort,
        replacement.path,
        replacement.backendOrigin,
        replacement.serveConfigSha256,
        replacement.createdAt,
        expected.leaseId,
        expected.configFingerprint,
        expected.nodeIdentitySha256,
        expected.advertisedOrigin,
        expected.httpsPort,
        expected.path,
        expected.backendOrigin,
        expected.serveConfigSha256,
        expected.createdAt
      );
    return result.changes === 1;
  }

  deleteExact(rawLease: Parameters<ExposureLeaseStorePort["deleteExact"]>[0]): boolean {
    const lease = tailscaleServeLeaseSchema.parse(rawLease);
    const result = this.database
      .prepare(
        `DELETE FROM server_exposure_leases
         WHERE slot='tailscale_https' AND lease_id=? AND config_fingerprint=?
           AND node_identity_sha256=? AND advertised_origin=? AND https_port=?
           AND route_path=? AND backend_origin=? AND serve_config_sha256=? AND created_at=?`
      )
      .run(
        lease.leaseId,
        lease.configFingerprint,
        lease.nodeIdentitySha256,
        lease.advertisedOrigin,
        lease.httpsPort,
        lease.path,
        lease.backendOrigin,
        lease.serveConfigSha256,
        lease.createdAt
      );
    return result.changes === 1;
  }
}
