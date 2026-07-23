import { createHash } from "node:crypto";
import {
  type ArtifactMediaType,
  artifactRefSchema,
  canonicalizeExecutionEnvelope,
  dispatchIdSchema,
  executionAttemptIdSchema,
  executionEnvelopeDigestSchema,
  executionEnvelopeSchema,
  leaseIdSchema,
  type DispatchResult,
  type ExecutionEnvelope
} from "@planweave-ai/distributed-protocol";
import { z } from "zod";
import { artifactMediaTypeSchema } from "./artifactMediaType.js";
import type { ArtifactMetadata } from "./artifacts.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const grantIdSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const artifactPermissionSchema = z.enum(["input_read", "report_write", "output_write"]);
const artifactPurposeSchema = z.enum(["input", "report", "output"]);

export type ArtifactPermission = z.infer<typeof artifactPermissionSchema>;
export type OutputArtifactPermission = Exclude<ArtifactPermission, "input_read">;

const grantRowSchema = z
  .object({
    grant_id: grantIdSchema,
    request_fingerprint: sha256Schema,
    project_id: z.string().min(1),
    host_id: z.string().min(1),
    dispatch_id: dispatchIdSchema,
    lease_id: leaseIdSchema,
    execution_attempt_id: executionAttemptIdSchema,
    permission: artifactPermissionSchema,
    artifact_ref: artifactRefSchema,
    expected_sha256: sha256Schema,
    expected_size_bytes: z.number().int().nonnegative().nullable(),
    expected_media_type: artifactMediaTypeSchema.nullable(),
    expires_at: z.string().datetime(),
    revoked_at: z.string().datetime().nullable(),
    consumed_at: z.string().datetime().nullable(),
    created_at: z.string().datetime()
  })
  .strict();

const linkRowSchema = z
  .object({
    dispatch_id: dispatchIdSchema,
    lease_id: leaseIdSchema,
    execution_attempt_id: executionAttemptIdSchema,
    artifact_ref: artifactRefSchema,
    purpose: artifactPurposeSchema,
    logical_name: z.string().nullable(),
    grant_id: grantIdSchema,
    produced_by_host_id: z.string().nullable(),
    linked_at: z.string().datetime()
  })
  .strict();

export type ArtifactGrant = {
  grantId: string;
  projectId: string;
  hostId: string;
  dispatchId: string;
  leaseId: string;
  executionAttemptId: string;
  permission: ArtifactPermission;
  artifactRef: string;
  expectedSha256: string;
  expectedSizeBytes?: number;
  expectedMediaType?: ArtifactMediaType;
  expiresAt: string;
  revokedAt?: string;
  consumedAt?: string;
  createdAt: string;
};

export type AcceptedArtifactProvenance = {
  dispatchId: string;
  leaseId: string;
  executionAttemptId: string;
  artifactRef: string;
  purpose: "report" | "output";
  grantId: string;
  producedByHostId: string;
  acceptedAt: string;
};

type DispatchScope = {
  projectId: string;
  hostId: string;
  dispatchId: string;
  leaseId: string;
  executionAttemptId: string;
};

type OutputGrantInput = DispatchScope & {
  operationId: string;
  permission: OutputArtifactPermission;
  expectedSha256: string;
  expectedSizeBytes: number;
  expectedMediaType: string;
};

const grantColumns = `grant_id,request_fingerprint,project_id,host_id,dispatch_id,lease_id,
  execution_attempt_id,permission,artifact_ref,expected_sha256,expected_size_bytes,
  expected_media_type,expires_at,revoked_at,consumed_at,created_at`;
const linkColumns = `dispatch_id,lease_id,execution_attempt_id,artifact_ref,purpose,logical_name,
  grant_id,produced_by_host_id,linked_at`;

function toGrant(raw: Record<string, unknown>): ArtifactGrant {
  const row = grantRowSchema.parse(raw);
  return {
    grantId: row.grant_id,
    projectId: row.project_id,
    hostId: row.host_id,
    dispatchId: row.dispatch_id,
    leaseId: row.lease_id,
    executionAttemptId: row.execution_attempt_id,
    permission: row.permission,
    artifactRef: row.artifact_ref,
    expectedSha256: row.expected_sha256,
    expectedSizeBytes: row.expected_size_bytes ?? undefined,
    expectedMediaType: row.expected_media_type ?? undefined,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at ?? undefined,
    consumedAt: row.consumed_at ?? undefined,
    createdAt: row.created_at
  };
}

function fingerprint(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function refForDigest(sha256: string): string {
  return artifactRefSchema.parse(`artifact:sha256:${sha256Schema.parse(sha256)}`);
}

function inputGrantId(scope: DispatchScope, artifactRef: string, logicalName: string): string {
  const suffix = createHash("sha256")
    .update(
      `${scope.hostId}\0${scope.dispatchId}\0${scope.leaseId}\0${artifactRef}\0${logicalName}`
    )
    .digest("hex");
  return `input-read:${suffix}`;
}

export class ArtifactAuthorizationRepository {
  constructor(private readonly database: SqliteDatabase) {}

  recordExecutionEnvelope(dispatchId: string, digest: string, envelope: ExecutionEnvelope): void {
    const parsedDispatchId = dispatchIdSchema.parse(dispatchId);
    const parsedDigest = executionEnvelopeDigestSchema.parse(digest);
    const parsedEnvelope = executionEnvelopeSchema.parse(envelope);
    const canonicalJson = canonicalizeExecutionEnvelope(parsedEnvelope);
    const existing = this.database
      .prepare(
        "SELECT envelope_digest,canonical_json FROM dispatch_execution_envelopes WHERE dispatch_id=?"
      )
      .get(parsedDispatchId);
    if (existing) {
      if (existing.envelope_digest !== parsedDigest || existing.canonical_json !== canonicalJson) {
        throw new Error("dispatch_envelope_identity_conflict");
      }
      return;
    }
    this.database
      .prepare(
        `INSERT INTO dispatch_execution_envelopes(
          dispatch_id,envelope_digest,canonical_json,created_at
        ) VALUES (?,?,?,?)`
      )
      .run(parsedDispatchId, parsedDigest, canonicalJson, new Date().toISOString());
  }

  assertExecutionEnvelopeReplay(
    dispatchId: string,
    digest: string,
    envelope: ExecutionEnvelope
  ): void {
    const row = this.database
      .prepare(
        "SELECT envelope_digest,canonical_json FROM dispatch_execution_envelopes WHERE dispatch_id=?"
      )
      .get(dispatchId);
    if (!row) throw new Error("dispatch_envelope_provenance_missing");
    if (
      row.envelope_digest !== executionEnvelopeDigestSchema.parse(digest) ||
      row.canonical_json !== canonicalizeExecutionEnvelope(executionEnvelopeSchema.parse(envelope))
    ) {
      throw new Error("dispatch_envelope_identity_conflict");
    }
  }

  grantDispatchInputs(scope: DispatchScope, envelope: ExecutionEnvelope): ArtifactGrant[] {
    const parsedEnvelope = executionEnvelopeSchema.parse(envelope);
    return parsedEnvelope.inputArtifacts.map((input) => {
      const blob = this.database
        .prepare("SELECT media_type FROM artifact_blobs WHERE ref=?")
        .get(input.artifactRef);
      if (!blob) throw new Error("dispatch_input_artifact_not_found");
      if (input.mediaType && blob.media_type !== input.mediaType) {
        throw new Error("dispatch_input_artifact_media_type_mismatch");
      }
      const expectedSha256 = input.artifactRef.slice("artifact:sha256:".length);
      const grant = this.insertGrant({
        ...scope,
        grantId: inputGrantId(scope, input.artifactRef, input.logicalName),
        permission: "input_read",
        artifactRef: input.artifactRef,
        expectedSha256,
        expiresAt: z
          .string()
          .datetime()
          .parse(this.requireDispatch(scope, ["leased"]).lease_expires_at)
      });
      this.insertInputLink(scope, input.artifactRef, input.logicalName, grant.grantId);
      return grant;
    });
  }

  createOutputGrant(input: OutputGrantInput): ArtifactGrant {
    const operationId = grantIdSchema.parse(input.operationId);
    const expectedSha256 = sha256Schema.parse(input.expectedSha256);
    const expectedSizeBytes = z.number().int().nonnegative().parse(input.expectedSizeBytes);
    const expectedMediaType = artifactMediaTypeSchema.parse(input.expectedMediaType);
    const permission = artifactPermissionSchema.exclude(["input_read"]).parse(input.permission);
    const artifactRef = refForDigest(expectedSha256);
    const request = {
      ...input,
      operationId,
      permission,
      expectedSha256,
      expectedSizeBytes,
      expectedMediaType,
      artifactRef
    };
    const requestFingerprint = fingerprint(request);
    const existing = this.getGrant(operationId);
    if (existing) {
      const stored = this.database
        .prepare("SELECT request_fingerprint FROM artifact_grants WHERE grant_id=?")
        .get(operationId);
      if (stored?.request_fingerprint !== requestFingerprint) {
        throw new Error("artifact_grant_identity_conflict");
      }
      this.assertGrantUsable(existing, input, true);
      return existing;
    }

    return inWriteTransaction(this.database, () => {
      const dispatch = this.requireDispatch(input, ["leased", "running", "cancelling"]);
      if (
        new Date(z.string().datetime().parse(dispatch.lease_expires_at)).getTime() <= Date.now()
      ) {
        throw new Error("artifact_grant_lease_expired");
      }
      const envelope = this.getExecutionEnvelope(input.dispatchId);
      if (expectedSizeBytes > envelope.output.maxArtifactBytes) {
        throw new Error("artifact_grant_size_exceeds_output_contract");
      }
      const pendingOperationLimit = Math.max(32, envelope.output.maxArtifactCount * 4);
      const pendingOperationCount = Number(
        this.database
          .prepare(
            `SELECT COUNT(*) AS count FROM artifact_grants
             WHERE dispatch_id=? AND lease_id=? AND execution_attempt_id=?
               AND permission IN ('report_write','output_write')
               AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?`
          )
          .get(input.dispatchId, input.leaseId, input.executionAttemptId, new Date().toISOString())
          ?.count ?? 0
      );
      if (pendingOperationCount >= pendingOperationLimit) {
        throw new Error("artifact_pending_operation_limit_exceeded");
      }
      return this.insertGrant({
        ...input,
        grantId: operationId,
        permission,
        artifactRef,
        expectedSha256,
        expectedSizeBytes,
        expectedMediaType,
        expiresAt: String(dispatch.lease_expires_at),
        requestFingerprint
      });
    });
  }

  authorizeInputRead(scope: DispatchScope & { artifactRef: string }): ArtifactGrant {
    const artifactRef = artifactRefSchema.parse(scope.artifactRef);
    const raw = this.database
      .prepare(
        `SELECT ${grantColumns} FROM artifact_grants
         WHERE host_id=? AND dispatch_id=? AND lease_id=? AND execution_attempt_id=?
           AND permission='input_read' AND artifact_ref=?`
      )
      .get(scope.hostId, scope.dispatchId, scope.leaseId, scope.executionAttemptId, artifactRef);
    if (!raw) throw new Error("artifact_input_grant_not_found");
    const grant = toGrant(raw);
    this.assertGrantUsable(grant, scope, false);
    return grant;
  }

  acceptOutputUpload(
    scope: DispatchScope & { grantId: string },
    artifact: ArtifactMetadata
  ): AcceptedArtifactProvenance {
    return inWriteTransaction(this.database, () => {
      const grant = this.getGrantRequired(scope.grantId);
      this.assertGrantUsable(grant, scope, true);
      if (grant.permission === "input_read") throw new Error("artifact_grant_not_writable");
      const storedArtifact = this.database
        .prepare("SELECT sha256,size_bytes,media_type FROM artifact_blobs WHERE ref=?")
        .get(grant.artifactRef);
      if (!storedArtifact) throw new Error("artifact_blob_not_found");
      if (
        artifact.ref !== grant.artifactRef ||
        artifact.sha256 !== grant.expectedSha256 ||
        artifact.sizeBytes !== grant.expectedSizeBytes ||
        artifact.mediaType !== grant.expectedMediaType ||
        storedArtifact.sha256 !== grant.expectedSha256 ||
        storedArtifact.size_bytes !== grant.expectedSizeBytes ||
        storedArtifact.media_type !== grant.expectedMediaType
      ) {
        throw new Error("artifact_upload_provenance_mismatch");
      }
      const purpose = grant.permission === "report_write" ? "report" : "output";
      if (grant.consumedAt) {
        return this.getAcceptedByGrant(grant.grantId, purpose);
      }
      const envelope = this.getExecutionEnvelope(scope.dispatchId);
      const acceptedCount = Number(
        this.database
          .prepare(
            `SELECT COUNT(*) AS count FROM dispatch_artifact_links
             WHERE dispatch_id=? AND execution_attempt_id=? AND purpose IN ('report','output')`
          )
          .get(scope.dispatchId, scope.executionAttemptId)?.count ?? 0
      );
      if (acceptedCount >= envelope.output.maxArtifactCount) {
        throw new Error("artifact_grant_count_exceeds_output_contract");
      }
      const acceptedAt = new Date().toISOString();
      const consumed = this.database
        .prepare(
          "UPDATE artifact_grants SET consumed_at=? WHERE grant_id=? AND consumed_at IS NULL"
        )
        .run(acceptedAt, grant.grantId);
      if (consumed.changes !== 1) throw new Error("artifact_grant_consumption_conflict");
      this.database
        .prepare(
          `INSERT INTO dispatch_artifact_links(
            project_id,host_id,dispatch_id,lease_id,execution_attempt_id,artifact_ref,
            purpose,permission,logical_name,grant_id,produced_by_host_id,linked_at
          ) VALUES (?,?,?,?,?,?,?, ?,NULL,?,?,?)`
        )
        .run(
          scope.projectId,
          scope.hostId,
          scope.dispatchId,
          scope.leaseId,
          scope.executionAttemptId,
          artifact.ref,
          purpose,
          grant.permission,
          grant.grantId,
          scope.hostId,
          acceptedAt
        );
      return this.getAcceptedByGrant(grant.grantId, purpose);
    });
  }

  revokeGrant(grantId: string): ArtifactGrant {
    const parsedGrantId = grantIdSchema.parse(grantId);
    const existing = this.getGrantRequired(parsedGrantId);
    if (existing.revokedAt) return existing;
    this.database
      .prepare("UPDATE artifact_grants SET revoked_at=? WHERE grant_id=? AND revoked_at IS NULL")
      .run(new Date().toISOString(), parsedGrantId);
    return this.getGrantRequired(parsedGrantId);
  }

  getGrant(grantId: string): ArtifactGrant | undefined {
    const raw = this.database
      .prepare(`SELECT ${grantColumns} FROM artifact_grants WHERE grant_id=?`)
      .get(grantIdSchema.parse(grantId));
    return raw ? toGrant(raw) : undefined;
  }

  getGrantRequired(grantId: string): ArtifactGrant {
    const grant = this.getGrant(grantId);
    if (!grant) throw new Error("artifact_grant_not_found");
    return grant;
  }

  requireAcceptedProvenance(
    scope: DispatchScope,
    artifactRef: string,
    purpose?: "report" | "output"
  ): AcceptedArtifactProvenance {
    const clauses = purpose ? " AND l.purpose=?" : " AND l.purpose IN ('report','output')";
    const values = [
      scope.projectId,
      scope.hostId,
      scope.dispatchId,
      scope.leaseId,
      scope.executionAttemptId,
      artifactRefSchema.parse(artifactRef)
    ];
    if (purpose) values.push(purpose);
    const raw = this.database
      .prepare(
        `SELECT ${linkColumns.replaceAll(/\b(dispatch_id|lease_id|execution_attempt_id|artifact_ref|purpose|logical_name|grant_id|produced_by_host_id|linked_at)\b/g, "l.$1")}
         FROM dispatch_artifact_links l
         JOIN artifact_grants g ON g.grant_id=l.grant_id
         JOIN dispatches d ON d.id=l.dispatch_id
         JOIN agent_hosts h ON h.id=l.produced_by_host_id
         WHERE d.project_id=? AND l.produced_by_host_id=? AND l.dispatch_id=? AND l.lease_id=?
           AND l.execution_attempt_id=? AND l.artifact_ref=?${clauses}
           AND l.project_id=g.project_id AND l.host_id=g.host_id
           AND l.dispatch_id=g.dispatch_id AND l.lease_id=g.lease_id
           AND l.execution_attempt_id=g.execution_attempt_id AND l.artifact_ref=g.artifact_ref
           AND l.permission=g.permission
           AND ((l.purpose='report' AND g.permission='report_write')
             OR (l.purpose='output' AND g.permission='output_write'))
           AND g.project_id=? AND g.host_id=? AND g.dispatch_id=? AND g.lease_id=?
           AND g.execution_attempt_id=? AND g.artifact_ref=?
           AND g.revoked_at IS NULL AND g.consumed_at IS NOT NULL AND h.revoked_at IS NULL`
      )
      .get(...values, ...values.slice(0, 6));
    if (!raw) throw new Error("artifact_provenance_not_found");
    return this.toAcceptedProvenance(raw);
  }

  requireResultProvenance(scope: DispatchScope, result: DispatchResult): void {
    this.requireAcceptedProvenance(scope, result.reportArtifactRef, "report");
    for (const artifactRef of new Set(result.artifactRefs)) {
      this.requireAcceptedProvenance(scope, artifactRef);
    }
  }

  private insertGrant(input: {
    grantId: string;
    projectId: string;
    hostId: string;
    dispatchId: string;
    leaseId: string;
    executionAttemptId: string;
    permission: ArtifactPermission;
    artifactRef: string;
    expectedSha256: string;
    expectedSizeBytes?: number;
    expectedMediaType?: ArtifactMediaType;
    expiresAt: string;
    requestFingerprint?: string;
  }): ArtifactGrant {
    const normalized = {
      ...input,
      grantId: grantIdSchema.parse(input.grantId),
      permission: artifactPermissionSchema.parse(input.permission),
      artifactRef: artifactRefSchema.parse(input.artifactRef),
      expectedSha256: sha256Schema.parse(input.expectedSha256),
      expectedMediaType: input.expectedMediaType
        ? artifactMediaTypeSchema.parse(input.expectedMediaType)
        : undefined
    };
    const requestFingerprint = input.requestFingerprint ?? fingerprint(normalized);
    const existing = this.getGrant(normalized.grantId);
    if (existing) {
      const stored = this.database
        .prepare("SELECT request_fingerprint FROM artifact_grants WHERE grant_id=?")
        .get(normalized.grantId);
      if (stored?.request_fingerprint !== requestFingerprint) {
        throw new Error("artifact_grant_identity_conflict");
      }
      return existing;
    }
    const createdAt = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO artifact_grants(
          grant_id,request_fingerprint,project_id,host_id,dispatch_id,lease_id,
          execution_attempt_id,permission,artifact_ref,expected_sha256,expected_size_bytes,
          expected_media_type,expires_at,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        normalized.grantId,
        requestFingerprint,
        normalized.projectId,
        normalized.hostId,
        normalized.dispatchId,
        normalized.leaseId,
        normalized.executionAttemptId,
        normalized.permission,
        normalized.artifactRef,
        normalized.expectedSha256,
        normalized.expectedSizeBytes ?? null,
        normalized.expectedMediaType ?? null,
        z.string().datetime().parse(normalized.expiresAt),
        createdAt
      );
    return this.getGrantRequired(normalized.grantId);
  }

  private insertInputLink(
    scope: DispatchScope,
    artifactRef: string,
    logicalName: string,
    grantId: string
  ): void {
    const existing = this.database
      .prepare(
        `SELECT grant_id,logical_name FROM dispatch_artifact_links
         WHERE dispatch_id=? AND execution_attempt_id=? AND purpose='input'
           AND artifact_ref=? AND logical_name=?`
      )
      .get(scope.dispatchId, scope.executionAttemptId, artifactRef, logicalName);
    if (existing) {
      if (existing.grant_id !== grantId || existing.logical_name !== logicalName) {
        throw new Error("dispatch_artifact_link_identity_conflict");
      }
      return;
    }
    this.database
      .prepare(
        `INSERT INTO dispatch_artifact_links(
          project_id,host_id,dispatch_id,lease_id,execution_attempt_id,artifact_ref,
          purpose,permission,logical_name,grant_id,produced_by_host_id,linked_at
        ) VALUES (?,?,?,?,?,?,'input','input_read',?,?,NULL,?)`
      )
      .run(
        scope.projectId,
        scope.hostId,
        scope.dispatchId,
        scope.leaseId,
        scope.executionAttemptId,
        artifactRef,
        logicalName,
        grantId,
        new Date().toISOString()
      );
  }

  private requireDispatch(
    scope: DispatchScope,
    statuses: readonly string[]
  ): Record<string, unknown> {
    const row = this.database
      .prepare(
        `SELECT d.project_id,d.host_id,d.lease_id,d.execution_attempt_id,d.lease_expires_at,d.status,
                h.revoked_at AS host_revoked_at
         FROM dispatches d JOIN agent_hosts h ON h.id=d.host_id WHERE d.id=?`
      )
      .get(scope.dispatchId);
    if (!row) throw new Error("artifact_dispatch_not_found");
    if (
      row.project_id !== scope.projectId ||
      row.host_id !== scope.hostId ||
      row.lease_id !== scope.leaseId ||
      row.execution_attempt_id !== scope.executionAttemptId
    ) {
      throw new Error("artifact_grant_scope_mismatch");
    }
    if (row.host_revoked_at) throw new Error("artifact_grant_host_revoked");
    if (!statuses.includes(String(row.status))) throw new Error("artifact_dispatch_status_invalid");
    return row;
  }

  private assertGrantUsable(grant: ArtifactGrant, scope: DispatchScope, writable: boolean): void {
    const dispatch = this.requireDispatch(scope, ["leased", "running", "cancelling"]);
    if (
      grant.projectId !== scope.projectId ||
      grant.hostId !== scope.hostId ||
      grant.dispatchId !== scope.dispatchId ||
      grant.leaseId !== scope.leaseId ||
      grant.executionAttemptId !== scope.executionAttemptId
    ) {
      throw new Error("artifact_grant_scope_mismatch");
    }
    if (grant.revokedAt) throw new Error("artifact_grant_revoked");
    const now = Date.now();
    if (
      new Date(grant.expiresAt).getTime() <= now ||
      new Date(String(dispatch.lease_expires_at)).getTime() <= now
    ) {
      throw new Error("artifact_grant_expired");
    }
    if (writable && grant.consumedAt) return;
  }

  private getExecutionEnvelope(dispatchId: string): ExecutionEnvelope {
    const row = this.database
      .prepare("SELECT canonical_json FROM dispatch_execution_envelopes WHERE dispatch_id=?")
      .get(dispatchId);
    if (!row) throw new Error("dispatch_envelope_provenance_missing");
    return executionEnvelopeSchema.parse(JSON.parse(String(row.canonical_json)));
  }

  private getAcceptedByGrant(
    grantId: string,
    purpose: "report" | "output"
  ): AcceptedArtifactProvenance {
    const raw = this.database
      .prepare(
        `SELECT ${linkColumns} FROM dispatch_artifact_links
         WHERE grant_id=? AND purpose=?`
      )
      .get(grantId, purpose);
    if (!raw) throw new Error("artifact_provenance_not_found");
    return this.toAcceptedProvenance(raw);
  }

  private toAcceptedProvenance(raw: Record<string, unknown>): AcceptedArtifactProvenance {
    const row = linkRowSchema.parse(raw);
    if (row.purpose === "input" || !row.produced_by_host_id) {
      throw new Error("artifact_provenance_not_accepted_output");
    }
    return {
      dispatchId: row.dispatch_id,
      leaseId: row.lease_id,
      executionAttemptId: row.execution_attempt_id,
      artifactRef: row.artifact_ref,
      purpose: row.purpose,
      grantId: row.grant_id,
      producedByHostId: row.produced_by_host_id,
      acceptedAt: row.linked_at
    };
  }
}
