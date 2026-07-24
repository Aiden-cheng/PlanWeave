import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  commentAttachmentFileNameSchema,
  commentAttachmentMediaTypeSchema,
  commentAttachmentMetadataSchema,
  commentContentSha256Schema,
  commentIdSchema,
  pendingAttachmentUploadIdSchema,
  pendingAttachmentUploadSchema,
  type CommentAttachmentInput,
  type CommentAttachmentMetadata,
  type CommentId,
  type PendingAttachmentUploadId
} from "../comments/schemas.js";
import {
  humanPrincipalIdSchema,
  humanProjectIdSchema
} from "../identity/schemas.js";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import {
  ATTACHMENT_ERROR_MESSAGES,
  type AttachmentErrorCode
} from "./errors.js";
import type {
  CommentAttachmentBinding,
  PendingUploadRecord,
  PendingUploadStatus
} from "./policy.js";

export class AttachmentRepositoryError extends Error {
  constructor(
    readonly code: AttachmentErrorCode,
    message: string = ATTACHMENT_ERROR_MESSAGES[code]
  ) {
    super(message);
    this.name = "AttachmentRepositoryError";
  }
}

const pendingStatusSchema = z.enum([
  "pending",
  "uploaded",
  "finalized",
  "expired",
  "aborted"
]);

type PendingRow = {
  pending_upload_id: string;
  project_id: string;
  uploader_human_principal_id: string;
  expected_digest_sha256: string | null;
  expected_size_bytes: number;
  media_type: string;
  file_name: string | null;
  comment_id: string | null;
  status: string;
  digest_sha256: string | null;
  created_at: string;
  expires_at: string;
  uploaded_at: string | null;
  finalized_at: string | null;
};

type BindingRow = {
  project_id: string;
  comment_id: string;
  digest_sha256: string;
  size_bytes: number;
  media_type: string;
  file_name: string | null;
  created_at: string;
  comment_tombstoned_at: string | null;
};

function toPendingRecord(row: PendingRow): PendingUploadRecord {
  const base = pendingAttachmentUploadSchema.parse({
    pendingUploadId: row.pending_upload_id,
    projectId: row.project_id,
    uploaderHumanPrincipalId: row.uploader_human_principal_id,
    expectedDigestSha256: row.expected_digest_sha256 ?? undefined,
    expectedSizeBytes: row.expected_size_bytes,
    mediaType: row.media_type,
    fileName: row.file_name ?? undefined,
    commentId: row.comment_id ?? undefined,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  });
  return {
    ...base,
    status: pendingStatusSchema.parse(row.status),
    digestSha256: row.digest_sha256 ?? undefined,
    uploadedAt: row.uploaded_at ?? undefined,
    finalizedAt: row.finalized_at ?? undefined
  };
}

function toBinding(row: BindingRow): CommentAttachmentBinding {
  return {
    projectId: humanProjectIdSchema.parse(row.project_id),
    commentId: commentIdSchema.parse(row.comment_id),
    digestSha256: commentContentSha256Schema.parse(row.digest_sha256),
    sizeBytes: row.size_bytes,
    mediaType: commentAttachmentMediaTypeSchema.parse(row.media_type),
    fileName: row.file_name
      ? commentAttachmentFileNameSchema.parse(row.file_name)
      : undefined,
    createdAt: row.created_at,
    commentTombstonedAt: row.comment_tombstoned_at ?? undefined
  };
}

export class CommentAttachmentRepository {
  constructor(private readonly database: SqliteDatabase) {}

  createPendingUpload(input: {
    projectId: string;
    uploaderHumanPrincipalId: string;
    expectedSizeBytes: number;
    mediaType: string;
    fileName?: string;
    expectedDigestSha256?: string;
    commentId?: string;
    createdAt: string;
    expiresAt: string;
  }): PendingUploadRecord {
    const pendingUploadId = pendingAttachmentUploadIdSchema.parse(randomUUID());
    const projectId = humanProjectIdSchema.parse(input.projectId);
    const uploaderHumanPrincipalId = humanPrincipalIdSchema.parse(
      input.uploaderHumanPrincipalId
    );
    const mediaType = commentAttachmentMediaTypeSchema.parse(input.mediaType);
    const expectedDigestSha256 = input.expectedDigestSha256
      ? commentContentSha256Schema.parse(input.expectedDigestSha256)
      : null;
    const fileName = input.fileName
      ? commentAttachmentFileNameSchema.parse(input.fileName)
      : null;
    const commentId = input.commentId ? commentIdSchema.parse(input.commentId) : null;

    this.database
      .prepare(
        `INSERT INTO comment_pending_uploads(
          pending_upload_id,project_id,uploader_human_principal_id,
          expected_digest_sha256,expected_size_bytes,media_type,file_name,comment_id,
          status,digest_sha256,created_at,expires_at,uploaded_at,finalized_at
        ) VALUES (?,?,?,?,?,?,?,?, 'pending', NULL,?,?, NULL, NULL)`
      )
      .run(
        pendingUploadId,
        projectId,
        uploaderHumanPrincipalId,
        expectedDigestSha256,
        input.expectedSizeBytes,
        mediaType,
        fileName,
        commentId,
        input.createdAt,
        input.expiresAt
      );

    return this.getPendingRequired(projectId, pendingUploadId);
  }

  getPending(
    projectId: string,
    pendingUploadId: string
  ): PendingUploadRecord | undefined {
    const raw = this.database
      .prepare(
        `SELECT * FROM comment_pending_uploads
         WHERE project_id=? AND pending_upload_id=?`
      )
      .get(humanProjectIdSchema.parse(projectId), pendingUploadId);
    if (!raw) return undefined;
    return toPendingRecord(raw as PendingRow);
  }

  getPendingRequired(
    projectId: string,
    pendingUploadId: string
  ): PendingUploadRecord {
    const record = this.getPending(projectId, pendingUploadId);
    if (!record) {
      throw new AttachmentRepositoryError("attachment_pending_not_found");
    }
    return record;
  }

  /**
   * CAS: pending → uploaded with verified digest. Concurrent uploaders lose with status conflict.
   */
  markUploaded(input: {
    projectId: string;
    pendingUploadId: string;
    digestSha256: string;
    sizeBytes: number;
    mediaType: string;
    uploadedAt: string;
  }): PendingUploadRecord {
    return inWriteTransaction(this.database, () => {
      const current = this.getPendingRequired(input.projectId, input.pendingUploadId);
      if (current.status !== "pending") {
        throw new AttachmentRepositoryError("attachment_status_conflict");
      }
      if (current.expectedSizeBytes !== input.sizeBytes) {
        throw new AttachmentRepositoryError("attachment_size_mismatch");
      }
      if (current.mediaType !== input.mediaType) {
        throw new AttachmentRepositoryError("attachment_media_type");
      }
      if (
        current.expectedDigestSha256 !== undefined &&
        current.expectedDigestSha256 !== input.digestSha256
      ) {
        throw new AttachmentRepositoryError("attachment_digest_mismatch");
      }

      const result = this.database
        .prepare(
          `UPDATE comment_pending_uploads
           SET status='uploaded', digest_sha256=?, uploaded_at=?,
               expected_digest_sha256=COALESCE(expected_digest_sha256, ?)
           WHERE project_id=? AND pending_upload_id=? AND status='pending'`
        )
        .run(
          commentContentSha256Schema.parse(input.digestSha256),
          input.uploadedAt,
          commentContentSha256Schema.parse(input.digestSha256),
          humanProjectIdSchema.parse(input.projectId),
          pendingAttachmentUploadIdSchema.parse(input.pendingUploadId)
        );
      if (result.changes !== 1) {
        throw new AttachmentRepositoryError("attachment_status_conflict");
      }
      return this.getPendingRequired(input.projectId, input.pendingUploadId);
    });
  }

  /**
   * CAS: uploaded → finalized. Returns metadata for comment create inputs.
   */
  finalize(input: {
    projectId: string;
    pendingUploadId: string;
    expected: CommentAttachmentInput;
    finalizedAt: string;
  }): { record: PendingUploadRecord; metadata: CommentAttachmentMetadata } {
    return inWriteTransaction(this.database, () => {
      const current = this.getPendingRequired(input.projectId, input.pendingUploadId);
      if (current.status === "finalized") {
        // Idempotent finalize when digest/size/media match.
        if (
          current.digestSha256 === input.expected.digestSha256 &&
          current.expectedSizeBytes === input.expected.sizeBytes &&
          current.mediaType === input.expected.mediaType
        ) {
          return {
            record: current,
            metadata: commentAttachmentMetadataSchema.parse({
              digestSha256: current.digestSha256,
              sizeBytes: current.expectedSizeBytes,
              mediaType: current.mediaType,
              fileName: current.fileName ?? input.expected.fileName,
              createdAt: current.finalizedAt ?? current.uploadedAt ?? current.createdAt
            })
          };
        }
        throw new AttachmentRepositoryError("attachment_status_conflict");
      }
      if (current.status !== "uploaded") {
        throw new AttachmentRepositoryError("attachment_status_conflict");
      }
      if (current.digestSha256 !== input.expected.digestSha256) {
        throw new AttachmentRepositoryError("attachment_digest_mismatch");
      }
      if (current.expectedSizeBytes !== input.expected.sizeBytes) {
        throw new AttachmentRepositoryError("attachment_size_mismatch");
      }
      if (current.mediaType !== input.expected.mediaType) {
        throw new AttachmentRepositoryError("attachment_media_type");
      }
      if (String(current.pendingUploadId) !== String(input.expected.pendingUploadId)) {
        throw new AttachmentRepositoryError("attachment_input_invalid");
      }

      const result = this.database
        .prepare(
          `UPDATE comment_pending_uploads
           SET status='finalized', finalized_at=?,
               file_name=COALESCE(?, file_name)
           WHERE project_id=? AND pending_upload_id=? AND status='uploaded'`
        )
        .run(
          input.finalizedAt,
          input.expected.fileName ?? null,
          humanProjectIdSchema.parse(input.projectId),
          pendingAttachmentUploadIdSchema.parse(input.pendingUploadId)
        );
      if (result.changes !== 1) {
        throw new AttachmentRepositoryError("attachment_status_conflict");
      }
      const record = this.getPendingRequired(input.projectId, input.pendingUploadId);
      return {
        record,
        metadata: commentAttachmentMetadataSchema.parse({
          digestSha256: record.digestSha256,
          sizeBytes: record.expectedSizeBytes,
          mediaType: record.mediaType,
          fileName: record.fileName,
          createdAt: record.finalizedAt ?? input.finalizedAt
        })
      };
    });
  }

  markExpired(projectId: string, pendingUploadId: string): void {
    this.database
      .prepare(
        `UPDATE comment_pending_uploads SET status='expired'
         WHERE project_id=? AND pending_upload_id=?
           AND status IN ('pending','uploaded')`
      )
      .run(
        humanProjectIdSchema.parse(projectId),
        pendingAttachmentUploadIdSchema.parse(pendingUploadId)
      );
  }

  /**
   * Bind finalized digests to a comment id for authorized download by comment scope.
   * Used by comment create (B-003) and tests; B-002 exposes it for tombstone policy.
   */
  bindCommentAttachments(input: {
    projectId: string;
    commentId: string;
    attachments: readonly CommentAttachmentMetadata[];
    createdAt: string;
  }): CommentAttachmentBinding[] {
    return inWriteTransaction(this.database, () => {
      const projectId = humanProjectIdSchema.parse(input.projectId);
      const commentId = commentIdSchema.parse(input.commentId);
      const bindings: CommentAttachmentBinding[] = [];
      for (const attachment of input.attachments) {
        this.database
          .prepare(
            `INSERT INTO comment_attachment_bindings(
              project_id,comment_id,digest_sha256,size_bytes,media_type,file_name,
              created_at,comment_tombstoned_at
            ) VALUES (?,?,?,?,?,?,?, NULL)
            ON CONFLICT(project_id, comment_id, digest_sha256) DO UPDATE SET
              size_bytes=excluded.size_bytes,
              media_type=excluded.media_type,
              file_name=excluded.file_name`
          )
          .run(
            projectId,
            commentId,
            attachment.digestSha256,
            attachment.sizeBytes,
            attachment.mediaType,
            attachment.fileName ?? null,
            input.createdAt
          );
        bindings.push(
          this.getBindingRequired(projectId, commentId, attachment.digestSha256)
        );
      }
      return bindings;
    });
  }

  setCommentTombstoned(input: {
    projectId: string;
    commentId: string;
    tombstonedAt: string;
  }): void {
    this.database
      .prepare(
        `UPDATE comment_attachment_bindings
         SET comment_tombstoned_at=?
         WHERE project_id=? AND comment_id=?`
      )
      .run(
        input.tombstonedAt,
        humanProjectIdSchema.parse(input.projectId),
        commentIdSchema.parse(input.commentId)
      );
  }

  getBinding(
    projectId: string,
    commentId: string,
    digestSha256: string
  ): CommentAttachmentBinding | undefined {
    const raw = this.database
      .prepare(
        `SELECT * FROM comment_attachment_bindings
         WHERE project_id=? AND comment_id=? AND digest_sha256=?`
      )
      .get(
        humanProjectIdSchema.parse(projectId),
        commentIdSchema.parse(commentId),
        commentContentSha256Schema.parse(digestSha256)
      );
    if (!raw) return undefined;
    return toBinding(raw as BindingRow);
  }

  getBindingRequired(
    projectId: string,
    commentId: string,
    digestSha256: string
  ): CommentAttachmentBinding {
    const binding = this.getBinding(projectId, commentId, digestSha256);
    if (!binding) {
      throw new AttachmentRepositoryError("attachment_not_found");
    }
    return binding;
  }

  hasProjectReference(projectId: string, digestSha256: string): boolean {
    const project = humanProjectIdSchema.parse(projectId);
    const digest = commentContentSha256Schema.parse(digestSha256);
    const row = this.database
      .prepare(
        `SELECT 1 AS present FROM comment_pending_uploads
         WHERE project_id=? AND digest_sha256=? AND status IN ('uploaded','finalized')
         UNION ALL
         SELECT 1 AS present FROM comment_attachment_bindings
         WHERE project_id=? AND digest_sha256=?
         LIMIT 1`
      )
      .get(project, digest, project, digest);
    return Boolean(row);
  }

  /**
   * Expired staged uploads that are not finalized and not comment-bound.
   * Returns digests that may become unreferenced after row deletion.
   */
  listExpiredStagedForCleanup(nowIso: string, limit = 100): PendingUploadRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM comment_pending_uploads
         WHERE status IN ('pending','uploaded')
           AND expires_at <= ?
         ORDER BY expires_at ASC
         LIMIT ?`
      )
      .all(nowIso, limit) as PendingRow[];
    return rows.map(toPendingRecord);
  }

  deletePending(projectId: string, pendingUploadId: PendingAttachmentUploadId | string): {
    digestSha256?: string;
  } {
    const record = this.getPending(projectId, pendingUploadId);
    this.database
      .prepare(
        `DELETE FROM comment_pending_uploads
         WHERE project_id=? AND pending_upload_id=?`
      )
      .run(
        humanProjectIdSchema.parse(projectId),
        pendingAttachmentUploadIdSchema.parse(pendingUploadId)
      );
    return { digestSha256: record?.digestSha256 };
  }

  /** Resolve a finalized pending upload for comment create attachment inputs. */
  resolveFinalizedForCommentInput(
    projectId: string,
    input: CommentAttachmentInput
  ): CommentAttachmentMetadata {
    const record = this.getPendingRequired(projectId, input.pendingUploadId);
    if (record.status !== "finalized") {
      throw new AttachmentRepositoryError("attachment_status_conflict");
    }
    if (record.digestSha256 !== input.digestSha256) {
      throw new AttachmentRepositoryError("attachment_digest_mismatch");
    }
    if (record.expectedSizeBytes !== input.sizeBytes) {
      throw new AttachmentRepositoryError("attachment_size_mismatch");
    }
    if (record.mediaType !== input.mediaType) {
      throw new AttachmentRepositoryError("attachment_media_type");
    }
    return commentAttachmentMetadataSchema.parse({
      digestSha256: record.digestSha256,
      sizeBytes: record.expectedSizeBytes,
      mediaType: record.mediaType,
      fileName: input.fileName ?? record.fileName,
      createdAt: record.finalizedAt ?? record.uploadedAt ?? record.createdAt
    });
  }
}

export type { CommentId };
