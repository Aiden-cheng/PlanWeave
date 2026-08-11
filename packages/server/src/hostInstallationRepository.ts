import { hostInstallationIdSchema } from "@planweave-ai/agent-host-protocol";
import type { SqliteDatabase } from "./sqlite.js";

type HostInstallationGenerationRow = {
  id: string;
  installation_id: string | null;
  superseded_at: string | null;
};

export type HostInstallationGenerationTransition = {
  installationId: string;
  supersededHostId?: string;
};

export class HostInstallationRepository {
  constructor(private readonly database: SqliteDatabase) {}

  /** Must be called inside the enrollment write transaction before inserting nextHostId. */
  replaceCurrentGenerationInCallerTransaction(input: {
    installationId: string;
    supersedesHostId?: string;
    nextHostId: string;
    supersededAt: string;
  }): HostInstallationGenerationTransition {
    const installationId = hostInstallationIdSchema.parse(input.installationId);
    const current = this.database
      .prepare(
        `SELECT id,installation_id,superseded_at FROM agent_hosts
         WHERE installation_id=? AND superseded_at IS NULL`
      )
      .get(installationId) as HostInstallationGenerationRow | undefined;
    if (current && input.supersedesHostId && current.id !== input.supersedesHostId) {
      throw new Error("agent_host_installation_conflict");
    }

    const claimed =
      current ??
      (input.supersedesHostId
        ? (this.database
            .prepare("SELECT id,installation_id,superseded_at FROM agent_hosts WHERE id=?")
            .get(input.supersedesHostId) as HostInstallationGenerationRow | undefined)
        : undefined);
    if (
      claimed &&
      (claimed.superseded_at !== null ||
        (claimed.installation_id !== null && claimed.installation_id !== installationId))
    ) {
      throw new Error("agent_host_installation_conflict");
    }
    if (!claimed) return { installationId };

    const updated = this.database
      .prepare(
        `UPDATE agent_hosts
         SET installation_id=?,superseded_at=?,superseded_by_host_id=?,
             revoked_at=COALESCE(revoked_at,?)
         WHERE id=? AND superseded_at IS NULL`
      )
      .run(installationId, input.supersededAt, input.nextHostId, input.supersededAt, claimed.id);
    if (updated.changes !== 1) throw new Error("agent_host_installation_conflict");
    this.database
      .prepare("DELETE FROM agent_host_credential_rotations WHERE host_id=?")
      .run(claimed.id);
    return { installationId, supersededHostId: claimed.id };
  }
}
