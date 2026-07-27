import { createHash, randomBytes } from "node:crypto";
import {
  canonicalizeJson,
  hostEnrollmentCompletedSchema,
  hostEnrollmentRequestSchema,
  opaqueIdentifierSchema,
  type HostEnrollmentCompleted,
  type HostEnrollmentErrorCode,
  type HostEnrollmentRequest
} from "@planweave-ai/distributed-protocol";
import { AgentHostRepository } from "./hosts.js";
import { WorkspaceIdentityRepository } from "./identity/workspaceRepository.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";

type EnrollmentGrantRow = {
  code_hash: string;
  expires_at: string;
  credential_expires_at: string;
  revoked_at: string | null;
  used_at: string | null;
  used_attempt_id: string | null;
  used_request_hash: string | null;
  host_id: string | null;
  created_at: string;
};

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export class HostEnrollmentError extends Error {
  constructor(readonly code: HostEnrollmentErrorCode) {
    super("Agent Host enrollment was rejected.");
    this.name = "HostEnrollmentError";
  }
}

export class HostEnrollmentService {
  private readonly hosts: AgentHostRepository;
  private readonly workspaceIdentity: WorkspaceIdentityRepository;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date()
  ) {
    this.hosts = new AgentHostRepository(database, clock);
    this.workspaceIdentity = new WorkspaceIdentityRepository(database);
  }

  createGrant(options: { workspaceId: string; expiresAt: Date; credentialExpiresAt: Date }): {
    enrollmentCode: string;
    workspaceId: string;
    expiresAt: string;
  } {
    const workspaceId = opaqueIdentifierSchema.parse(options.workspaceId);
    if (!this.workspaceIdentity.workspaceExists(workspaceId)) {
      throw new Error("workspace_not_found");
    }
    this.workspaceIdentity.assertReadCutover(workspaceId);
    const now = this.clock();
    if (
      options.expiresAt.getTime() <= now.getTime() ||
      options.credentialExpiresAt.getTime() <= options.expiresAt.getTime()
    ) {
      throw new Error("host_enrollment_grant_expiry_invalid");
    }
    const enrollmentCode = `pw_enroll_${randomBytes(32).toString("base64url")}`;
    inWriteTransaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO agent_host_enrollment_grants(
            code_hash,expires_at,credential_expires_at,created_at
          ) VALUES(?,?,?,?)`
        )
        .run(
          hash(enrollmentCode),
          options.expiresAt.toISOString(),
          options.credentialExpiresAt.toISOString(),
          now.toISOString()
        );
      this.workspaceIdentity.bindEnrollmentToWorkspace(hash(enrollmentCode), workspaceId);
    });
    return { enrollmentCode, workspaceId, expiresAt: options.expiresAt.toISOString() };
  }

  revokeGrant(enrollmentCode: string): void {
    const codeHash = hash(enrollmentCode);
    const updated = this.database
      .prepare(
        "UPDATE agent_host_enrollment_grants SET revoked_at=? WHERE code_hash=? AND revoked_at IS NULL"
      )
      .run(this.clock().toISOString(), codeHash);
    if (updated.changes !== 1) throw new Error("host_enrollment_grant_not_found_or_revoked");
    this.workspaceIdentity.synchronizeEnrollment(codeHash);
  }

  /** Explicitly authorize an enrollment grant for one workspace. */
  bindGrantToWorkspace(enrollmentCode: string, workspaceId: string): void {
    this.workspaceIdentity.bindEnrollmentToWorkspace(hash(enrollmentCode), workspaceId);
  }

  exchange(input: unknown): HostEnrollmentCompleted {
    const request = hostEnrollmentRequestSchema.parse(input);
    return inWriteTransaction(this.database, () => this.exchangeLocked(request));
  }

  private exchangeLocked(request: HostEnrollmentRequest): HostEnrollmentCompleted {
    const row = this.database
      .prepare("SELECT * FROM agent_host_enrollment_grants WHERE code_hash=?")
      .get(hash(request.enrollmentCode)) as EnrollmentGrantRow | undefined;
    if (!row) throw new HostEnrollmentError("invalid");
    const workspaceId = this.workspaceIdentity.workspaceForEnrollment(row.code_hash);
    if (!workspaceId) throw new HostEnrollmentError("invalid");
    const now = this.clock();
    if (row.revoked_at) throw new HostEnrollmentError("revoked");
    if (Date.parse(row.expires_at) <= now.getTime()) throw new HostEnrollmentError("expired");
    const requestHash = hash(
      canonicalizeJson({
        enrollmentAttemptId: request.enrollmentAttemptId,
        credentialTokenHash: hash(request.credentialToken),
        displayName: request.displayName,
        capabilities: request.capabilities,
        capacity: request.capacity
      })
    );
    if (row.used_at) {
      if (
        row.used_attempt_id !== request.enrollmentAttemptId ||
        row.used_request_hash !== requestHash ||
        !row.host_id
      ) {
        throw new HostEnrollmentError("conflict");
      }
      return hostEnrollmentCompletedSchema.parse({
        type: "host.enrollment.completed",
        protocolVersion: 1,
        enrollmentAttemptId: request.enrollmentAttemptId,
        hostId: row.host_id,
        workspaceId,
        credentialExpiresAt: row.credential_expires_at
      });
    }
    const registration = this.hosts.registerWithCredential(
      request.displayName,
      request.credentialToken,
      request.capabilities,
      request.capacity,
      row.credential_expires_at
    );
    this.hosts.bindToWorkspace(registration.host.id, workspaceId);
    const updated = this.database
      .prepare(
        `UPDATE agent_host_enrollment_grants
         SET used_at=?,used_attempt_id=?,used_request_hash=?,host_id=?
         WHERE code_hash=? AND used_at IS NULL`
      )
      .run(
        now.toISOString(),
        request.enrollmentAttemptId,
        requestHash,
        registration.host.id,
        row.code_hash
      );
    if (updated.changes !== 1) throw new HostEnrollmentError("conflict");
    this.workspaceIdentity.synchronizeEnrollment(row.code_hash);
    return hostEnrollmentCompletedSchema.parse({
      type: "host.enrollment.completed",
      protocolVersion: 1,
      enrollmentAttemptId: request.enrollmentAttemptId,
      hostId: registration.host.id,
      workspaceId,
      credentialExpiresAt: row.credential_expires_at
    });
  }
}
