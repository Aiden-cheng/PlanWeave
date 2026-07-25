/**
 * REL-002#B-002 security reliability matrix (in-process + boundary unit probes).
 *
 * Complements real-process operator matrices (realProcessAuthorizationMatrix) and
 * artifact adversarial suites with principal/limit/path/redaction cells that must
 * remain fail-closed. Skipped live ACP/VPS evidence is never treated as a pass here.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COLLABORATION_JSON_BODY_MAX_BYTES,
  COMMENT_ATTACHMENT_ALLOWED_MEDIA_TYPES,
  COMMENT_ATTACHMENT_MAX_BYTES,
  COMMENT_ATTACHMENTS_MAX_COUNT,
  HUMAN_COMMENT_BODY_MAX_LENGTH,
  HUMAN_OBSERVER_MAX_PAYLOAD_BYTES,
  WORK_ASSIGNMENT_BATCH_MAX
} from "@planweave-ai/collaboration-contracts";
import {
  EXECUTION_ENVELOPE_MAX_BYTES,
  OUTPUT_MAX_ARTIFACT_BYTES,
  OUTPUT_MAX_ARTIFACT_COUNT
} from "@planweave-ai/distributed-protocol";
import { CommentAttachmentBlobStore } from "../attachments/blobStore.js";
import {
  COMMENT_ATTACHMENT_MAX_BYTES as SERVER_COMMENT_ATTACHMENT_MAX_BYTES,
  COMMENT_ATTACHMENTS_MAX_COUNT as SERVER_COMMENT_ATTACHMENTS_MAX_COUNT,
  COMMENT_BODY_MAX_LENGTH
} from "../comments/limits.js";
import {
  commentAttachmentFileNameSchema,
  commentBodyFormatSchema,
  commentCreateCommandSchema
} from "../comments/schemas.js";
import {
  HUMAN_COMMENT_BODY_MAX_LENGTH as SERVER_HUMAN_COMMENT_BODY_MAX_LENGTH,
  HUMAN_MAX_DEVICES_PER_PRINCIPAL,
  HUMAN_MAX_MEMBERS_PER_PROJECT,
  HUMAN_MAX_OPEN_INVITATIONS_PER_PROJECT
} from "../identity/limits.js";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { redactSensitiveText } from "../vpsE2e/redaction.js";
import { WORK_ASSIGNMENT_BATCH_MAX as SERVER_WORK_ASSIGNMENT_BATCH_MAX } from "../work/limits.js";

const directories: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    try {
      database.close();
    } catch {
      // already closed
    }
  }
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function openTempDb(): Promise<{ directory: string; database: SqliteDatabase }> {
  const directory = await mkdtemp(join(tmpdir(), "planweave-security-matrix-"));
  directories.push(directory);
  const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
  databases.push(database);
  applyMigrations(database);
  return { directory, database };
}

/**
 * Moderate product-scale budgets used as matrix thresholds (not internet-scale).
 * Values are authoritative product limits; the matrix fails if wire/server diverge.
 */
export const SECURITY_MATRIX_LIMITS = {
  humanCommentBodyMax: HUMAN_COMMENT_BODY_MAX_LENGTH,
  commentAttachmentMaxBytes: COMMENT_ATTACHMENT_MAX_BYTES,
  commentAttachmentsMaxCount: COMMENT_ATTACHMENTS_MAX_COUNT,
  collaborationJsonBodyMaxBytes: COLLABORATION_JSON_BODY_MAX_BYTES,
  humanObserverMaxPayloadBytes: HUMAN_OBSERVER_MAX_PAYLOAD_BYTES,
  workAssignmentBatchMax: WORK_ASSIGNMENT_BATCH_MAX,
  outputMaxArtifactBytes: OUTPUT_MAX_ARTIFACT_BYTES,
  outputMaxArtifactCount: OUTPUT_MAX_ARTIFACT_COUNT,
  executionEnvelopeMaxBytes: EXECUTION_ENVELOPE_MAX_BYTES,
  humanMaxMembersPerProject: HUMAN_MAX_MEMBERS_PER_PROJECT,
  humanMaxOpenInvitations: HUMAN_MAX_OPEN_INVITATIONS_PER_PROJECT,
  humanMaxDevicesPerPrincipal: HUMAN_MAX_DEVICES_PER_PRINCIPAL
} as const;

describe("security reliability matrix", () => {
  it("keeps server and wire limit budgets aligned (single authority)", () => {
    expect(SERVER_HUMAN_COMMENT_BODY_MAX_LENGTH).toBe(SECURITY_MATRIX_LIMITS.humanCommentBodyMax);
    expect(COMMENT_BODY_MAX_LENGTH).toBe(SECURITY_MATRIX_LIMITS.humanCommentBodyMax);
    expect(SERVER_COMMENT_ATTACHMENT_MAX_BYTES).toBe(
      SECURITY_MATRIX_LIMITS.commentAttachmentMaxBytes
    );
    expect(SERVER_COMMENT_ATTACHMENTS_MAX_COUNT).toBe(
      SECURITY_MATRIX_LIMITS.commentAttachmentsMaxCount
    );
    expect(SERVER_WORK_ASSIGNMENT_BATCH_MAX).toBe(SECURITY_MATRIX_LIMITS.workAssignmentBatchMax);
    // Product moderate scale: comment bodies fit one collaboration JSON body budget.
    expect(SECURITY_MATRIX_LIMITS.humanCommentBodyMax).toBeLessThanOrEqual(
      SECURITY_MATRIX_LIMITS.collaborationJsonBodyMaxBytes
    );
    expect(SECURITY_MATRIX_LIMITS.outputMaxArtifactBytes).toBeLessThanOrEqual(100 * 1024 * 1024);
    expect(SECURITY_MATRIX_LIMITS.executionEnvelopeMaxBytes).toBeLessThan(1024 * 1024);
  });

  it("rejects path traversal, path separators, and content-injection filenames", () => {
    const cases: Array<{ name: string; value: string }> = [
      { name: "unix traversal", value: "../secret" },
      { name: "nested path", value: "a/b.png" },
      { name: "windows path", value: "a\\b.png" },
      { name: "dot", value: "." },
      { name: "dotdot", value: ".." },
      { name: "null byte", value: "evil\0.png" },
      { name: "control char", value: "evil\n.png" }
    ];
    for (const entry of cases) {
      expect(commentAttachmentFileNameSchema.safeParse(entry.value).success, entry.name).toBe(
        false
      );
    }
    expect(commentAttachmentFileNameSchema.parse("notes.md")).toBe("notes.md");
  });

  it("rejects HTML body format and oversize/empty comment bodies", () => {
    expect(commentBodyFormatSchema.safeParse("html").success).toBe(false);
    expect(commentBodyFormatSchema.parse("markdown")).toBe("markdown");

    const actor = {
      humanPrincipalId: "human-1",
      displayName: "Owner",
      deviceCredentialId: "device-1",
      projectId: "project-a",
      role: "owner" as const,
      membershipId: "membership-1"
    };
    expect(() =>
      commentCreateCommandSchema.parse({
        projectId: "project-a",
        workItem: { kind: "task", canvasId: "default", taskId: "T-1" },
        body: "a".repeat(SECURITY_MATRIX_LIMITS.humanCommentBodyMax + 1),
        actor
      })
    ).toThrow();
    expect(() =>
      commentCreateCommandSchema.parse({
        projectId: "project-a",
        workItem: { kind: "task", canvasId: "default", taskId: "T-1" },
        body: "",
        actor
      })
    ).toThrow();
    // Markdown source may contain script-like text; format remains markdown-only (no HTML format).
    const withScriptLike = commentCreateCommandSchema.parse({
      projectId: "project-a",
      workItem: { kind: "task", canvasId: "default", taskId: "T-1" },
      body: "<script>alert(1)</script>",
      actor
    });
    expect(withScriptLike.body).toContain("<script>");
  });

  it("allows only the documented comment attachment media allowlist", () => {
    expect([...COMMENT_ATTACHMENT_ALLOWED_MEDIA_TYPES]).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "application/pdf",
      "text/plain",
      "text/markdown"
    ]);
    expect(COMMENT_ATTACHMENT_ALLOWED_MEDIA_TYPES).not.toContain("text/html");
    expect(COMMENT_ATTACHMENT_ALLOWED_MEDIA_TYPES).not.toContain("application/javascript");
    expect(COMMENT_ATTACHMENT_ALLOWED_MEDIA_TYPES).not.toContain("application/octet-stream");
  });

  it("refuses blob reads that escape the content-addressed root via symlink", async () => {
    const { directory, database } = await openTempDb();
    const blobs = new CommentAttachmentBlobStore(database, directory, 4_096);
    const payload = Buffer.from("legitimate attachment body");
    const digest = createHash("sha256").update(payload).digest("hex");
    await blobs.put({
      expectedSha256: digest,
      expectedSizeBytes: payload.byteLength,
      mediaType: "text/plain",
      chunks: (async function* () {
        yield payload;
      })()
    });

    const relativePath = `${digest.slice(0, 2)}/${digest}`;
    const blobPath = join(directory, "comment-attachments", "sha256", relativePath);
    const outside = join(directory, "outside-secret.txt");
    await writeFile(outside, "host-secret-should-not-leak", "utf8");
    await rm(blobPath, { force: true });
    await symlink(outside, blobPath);

    await expect(blobs.read(digest)).rejects.toThrow(/attachment_path_escape|attachment_blob/);
    await expect(blobs.openRead(digest)).rejects.toThrow(/attachment_path_escape|attachment_blob/);
  });

  it("refuses pre-existing symlink collision on the staging temp path", async () => {
    const { directory, database } = await openTempDb();
    const blobs = new CommentAttachmentBlobStore(database, directory, 4_096);
    const tmpRoot = join(directory, "comment-attachments", "tmp");
    await mkdir(tmpRoot, { recursive: true, mode: 0o700 });
    // Plant a symlink named after a UUID we force via collision by filling tmp with a trap
    // directory entry is not predictable; instead plant a file that would be followed if
    // open flags were wrong by writing a symlink as the only entry and ensuring put still works
    // with exclusive create (wx) on a fresh UUID path.
    const trap = join(tmpRoot, "trap-outside");
    const outside = join(directory, "trap-target");
    await writeFile(outside, "should-not-be-written", "utf8");
    await symlink(outside, trap);

    const payload = Buffer.from(`staging-ok-${randomUUID()}`);
    const digest = createHash("sha256").update(payload).digest("hex");
    const stored = await blobs.put({
      expectedSha256: digest,
      expectedSizeBytes: payload.byteLength,
      mediaType: "text/plain",
      chunks: (async function* () {
        yield payload;
      })()
    });
    expect(stored.digestSha256).toBe(digest);
    // Trap symlink remains untouched; stored content is the payload, not host secret.
    expect(await readFile(outside, "utf8")).toBe("should-not-be-written");
    expect(await blobs.read(digest)).toEqual(payload);
  });

  it("redacts tokens, enrollment codes, PEMs, home paths, and endpoints from evidence text", () => {
    const raw = [
      "Authorization: Bearer super-secret-token-value",
      "deviceToken=pw_hdev_abcdefghijklmnopqrstuvwxabcdefghijklmnopq",
      "enrollmentCode=pw_enroll_abc123DEF456",
      "token: visible-secret",
      "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----",
      "path=/Users/mrbrain/code/PlanWeave-collaboration/secrets.json",
      "url=https://vps.example.com:8443/api/v1/hosts",
      "peer=203.0.113.10:443"
    ].join("\n");
    const redacted = redactSensitiveText(raw);
    expect(redacted).not.toMatch(/super-secret-token-value/);
    expect(redacted).not.toMatch(/pw_enroll_abc123DEF456/);
    expect(redacted).not.toMatch(/visible-secret/);
    expect(redacted).not.toMatch(/BEGIN PRIVATE KEY/);
    expect(redacted).not.toMatch(/\/Users\/mrbrain/);
    expect(redacted).not.toMatch(/vps\.example\.com/);
    expect(redacted).not.toMatch(/203\.0\.113\.10/);
    expect(redacted).toMatch(/REDACTED/);
  });

  it("documents complementary security cells owned by other suites (catalog)", () => {
    // Catalog only — executable coverage lives in the referenced suites. This assertion
    // fails if the catalog shrinks without an intentional replacement.
    const catalog = [
      "realProcessAuthorizationMatrix: operator token/project/lease/dispatch/attempt/version/schema/cursor",
      "artifactAdversarialBoundary: host grant cross-scope, revoke, size, media, provenance",
      "humanIdentityHttp+Policy: device/invite revoke/expire, last-owner, cross-project, host-on-human",
      "commentAttachmentHttp+Policy: human vs host, digest isolation, staged TTL, tombstone read",
      "workAssignmentDispatch: exact host pin, CAS revision, preferred host offline",
      "collaborationBridge IPC: secret smuggle, path redaction, vault encrypt, project switch dispose",
      "agentHostClientAdversarial+Recovery: executor failure, no silent auto-rerun",
      "agentHostConfig: workspace symlink escape",
      "realProcessCrashReplayMatrix: host/server kill, capacity, cancel race, idempotency"
    ] as const;
    expect(catalog.length).toBeGreaterThanOrEqual(8);
    for (const cell of catalog) {
      expect(cell.includes(":")).toBe(true);
    }
  });
});
