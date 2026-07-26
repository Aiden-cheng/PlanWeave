import { createHash } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CommentAttachmentBlobStore,
  CommentAttachmentRepository,
  CommentAttachmentService,
  handleCommentAttachmentHttpRequest
} from "../attachments/index.js";
import {
  handleHumanHttpRequest,
  HumanIdentityRepository,
  HumanMembershipService,
  resetHumanHttpRateLimits
} from "../identity/index.js";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const servers: HttpServer[] = [];
const directories: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  resetHumanHttpRateLimits();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
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

async function setup(options?: { clock?: () => Date }) {
  const directory = await mkdtemp(join(tmpdir(), "planweave-comment-attach-"));
  directories.push(directory);
  const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
  databases.push(database);
  applyMigrations(database);

  const humanRepository = new HumanIdentityRepository(database, options?.clock);
  const projectAuthority = {
    hasProject: (projectId: string) => projectId === "project-a" || projectId === "project-b"
  };
  const humanService = new HumanMembershipService({
    repository: humanRepository,
    projectAuthority,
    clock: options?.clock
  });
  const attachmentRepository = new CommentAttachmentRepository(database);
  const blobs = new CommentAttachmentBlobStore(database, directory);
  const attachmentService = new CommentAttachmentService({
    repository: attachmentRepository,
    blobs,
    clock: options?.clock
  });

  const server = createServer((request, response) => {
    void (async () => {
      if (
        await handleHumanHttpRequest(request, response, {
          service: humanService,
          repository: humanRepository,
          projectAuthority,
          allowInsecureDevelopment: true,
          clock: options?.clock
        })
      ) {
        return;
      }
      if (
        await handleCommentAttachmentHttpRequest(request, response, {
          service: attachmentService,
          repository: humanRepository,
          allowInsecureDevelopment: true,
          clock: options?.clock
        })
      ) {
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "route_not_found" }));
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "request_failed" }));
      } else {
        response.destroy();
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    directory,
    database,
    attachmentService,
    attachmentRepository,
    blobs
  };
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function bootstrap(origin: string, projectId = "project-a", principalId = "human-owner-1") {
  const response = await fetch(`${origin}/api/v1/projects/${projectId}/human/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Owner", humanPrincipalId: principalId })
  });
  const payload = (await response.json()) as { deviceToken?: string; error?: string };
  if (!response.ok || !payload.deviceToken) {
    throw new Error(`bootstrap failed: ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload.deviceToken;
}

async function inviteAndJoin(
  origin: string,
  ownerToken: string,
  projectId: string,
  displayName: string
) {
  const invite = await fetch(`${origin}/api/v1/projects/${projectId}/human/invitations`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth(ownerToken) },
    body: JSON.stringify({})
  });
  const invitePayload = (await invite.json()) as { invitationToken?: string };
  expect(invite.status).toBe(201);
  const consume = await fetch(`${origin}/api/v1/projects/${projectId}/human/invitations/consume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      invitationToken: invitePayload.invitationToken,
      displayName
    })
  });
  const consumePayload = (await consume.json()) as { deviceToken?: string };
  expect(consume.status).toBe(201);
  return consumePayload.deviceToken!;
}

async function createPending(
  origin: string,
  token: string,
  projectId: string,
  body: Record<string, unknown>
) {
  const response = await fetch(`${origin}/api/v1/projects/${projectId}/attachments/pending`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth(token) },
    body: JSON.stringify(body)
  });
  const payload = (await response.json()) as Record<string, unknown>;
  return { response, payload };
}

async function uploadPending(
  origin: string,
  token: string,
  projectId: string,
  pendingUploadId: string,
  bytes: Buffer,
  mediaType: string,
  digest?: string
) {
  const headers: Record<string, string> = {
    "content-type": mediaType,
    "content-length": String(bytes.byteLength),
    ...auth(token)
  };
  if (digest) headers["x-planweave-content-sha256"] = digest;
  const response = await fetch(
    `${origin}/api/v1/projects/${projectId}/attachments/pending/${pendingUploadId}`,
    { method: "PUT", headers, body: bytes }
  );
  const payload = (await response.json()) as Record<string, unknown>;
  return { response, payload };
}

async function finalizePending(
  origin: string,
  token: string,
  projectId: string,
  pendingUploadId: string,
  attachment: Record<string, unknown>
) {
  const response = await fetch(
    `${origin}/api/v1/projects/${projectId}/attachments/pending/${pendingUploadId}/finalize`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...auth(token) },
      body: JSON.stringify(attachment)
    }
  );
  const payload = (await response.json()) as Record<string, unknown>;
  return { response, payload };
}

describe("comment attachment HTTP and blob authorization", () => {
  it("stages, streams with hash verification, finalizes, and downloads with safe headers", async () => {
    const { origin } = await setup();
    const token = await bootstrap(origin);
    const bytes = Buffer.from("hello attachment");
    const digest = createHash("sha256").update(bytes).digest("hex");

    const created = await createPending(origin, token, "project-a", {
      expectedSizeBytes: bytes.byteLength,
      mediaType: "text/plain",
      fileName: "note.txt",
      expectedDigestSha256: digest
    });
    expect(created.response.status).toBe(201);
    const pendingUploadId = created.payload.pendingUploadId as string;

    const uploaded = await uploadPending(
      origin,
      token,
      "project-a",
      pendingUploadId,
      bytes,
      "text/plain",
      digest
    );
    expect(uploaded.response.status).toBe(201);
    expect(uploaded.payload.digestSha256).toBe(digest);

    const finalized = await finalizePending(origin, token, "project-a", pendingUploadId, {
      pendingUploadId,
      digestSha256: digest,
      sizeBytes: bytes.byteLength,
      mediaType: "text/plain",
      fileName: "note.txt"
    });
    expect(finalized.response.status).toBe(200);
    expect((finalized.payload.attachment as { digestSha256: string }).digestSha256).toBe(digest);

    const download = await fetch(
      `${origin}/api/v1/projects/project-a/attachments/pending/${pendingUploadId}`,
      { headers: auth(token) }
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(download.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
  });

  it("rejects host-shaped credentials and unauthenticated access uniformly", async () => {
    const { origin } = await setup();
    await bootstrap(origin);
    const denied = await createPending(origin, "pw_host_not_a_real_host_token", "project-a", {
      expectedSizeBytes: 4,
      mediaType: "text/plain"
    });
    expect(denied.response.status).toBe(401);
    expect(denied.payload.error).toBe("attachment_auth_unauthenticated");

    const none = await fetch(`${origin}/api/v1/projects/project-a/attachments/pending`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedSizeBytes: 4, mediaType: "text/plain" })
    });
    expect(none.status).toBe(401);
  });

  it("enforces project isolation and does not authorize guessed digests", async () => {
    const { origin } = await setup();
    const tokenA = await bootstrap(origin, "project-a", "human-a");
    const tokenB = await bootstrap(origin, "project-b", "human-b");
    const bytes = Buffer.from("secret-a");
    const digest = createHash("sha256").update(bytes).digest("hex");

    const created = await createPending(origin, tokenA, "project-a", {
      expectedSizeBytes: bytes.byteLength,
      mediaType: "text/plain",
      expectedDigestSha256: digest
    });
    const pendingUploadId = created.payload.pendingUploadId as string;
    await uploadPending(origin, tokenA, "project-a", pendingUploadId, bytes, "text/plain", digest);
    await finalizePending(origin, tokenA, "project-a", pendingUploadId, {
      pendingUploadId,
      digestSha256: digest,
      sizeBytes: bytes.byteLength,
      mediaType: "text/plain"
    });

    const crossPending = await fetch(
      `${origin}/api/v1/projects/project-a/attachments/pending/${pendingUploadId}`,
      { headers: auth(tokenB) }
    );
    expect(crossPending.status).toBe(401);

    const crossDigest = await fetch(
      `${origin}/api/v1/projects/project-a/attachments/by-digest/${digest}`,
      { headers: auth(tokenB) }
    );
    expect(crossDigest.status).toBe(401);

    const guessed = await fetch(
      `${origin}/api/v1/projects/project-b/attachments/by-digest/${digest}`,
      { headers: auth(tokenB) }
    );
    expect(guessed.status).toBe(404);
    expect(((await guessed.json()) as { error: string }).error).toBe("attachment_not_found");
  });

  it("rejects digest/size/media mismatches and expired staged uploads", async () => {
    let now = new Date("2026-07-24T12:00:00.000Z");
    const { origin } = await setup({ clock: () => now });
    const token = await bootstrap(origin);
    const bytes = Buffer.from("payload-bytes");
    const digest = createHash("sha256").update(bytes).digest("hex");

    const created = await createPending(origin, token, "project-a", {
      expectedSizeBytes: bytes.byteLength,
      mediaType: "text/plain",
      expectedDigestSha256: digest,
      ttlMs: 60_000
    });
    const pendingUploadId = created.payload.pendingUploadId as string;

    const wrongDigest = await uploadPending(
      origin,
      token,
      "project-a",
      pendingUploadId,
      bytes,
      "text/plain",
      "0".repeat(64)
    );
    expect(wrongDigest.response.status).toBe(400);
    expect(wrongDigest.payload.error).toBe("attachment_digest_mismatch");

    const wrongSizePending = await createPending(origin, token, "project-a", {
      expectedSizeBytes: bytes.byteLength - 1,
      mediaType: "text/plain",
      expectedDigestSha256: digest
    });
    const wrongSize = await uploadPending(
      origin,
      token,
      "project-a",
      wrongSizePending.payload.pendingUploadId as string,
      bytes,
      "text/plain",
      digest
    );
    expect(wrongSize.response.status).toBe(400);
    expect(wrongSize.payload.error).toBe("attachment_size_mismatch");

    const wrongMediaPending = await createPending(origin, token, "project-a", {
      expectedSizeBytes: bytes.byteLength,
      mediaType: "text/plain",
      expectedDigestSha256: digest
    });
    const wrongMedia = await uploadPending(
      origin,
      token,
      "project-a",
      wrongMediaPending.payload.pendingUploadId as string,
      bytes,
      "image/png",
      digest
    );
    expect(wrongMedia.response.status).toBe(400);
    expect(wrongMedia.payload.error).toBe("attachment_media_type");

    await uploadPending(origin, token, "project-a", pendingUploadId, bytes, "text/plain", digest);
    now = new Date("2026-07-24T12:30:00.000Z");
    const expiredFinalize = await finalizePending(origin, token, "project-a", pendingUploadId, {
      pendingUploadId,
      digestSha256: digest,
      sizeBytes: bytes.byteLength,
      mediaType: "text/plain"
    });
    expect(expiredFinalize.response.status).toBe(409);
    expect(expiredFinalize.payload.error).toBe("attachment_pending_expired");
  });

  it("deduplicates identical content and handles concurrent finalize races", async () => {
    const { origin, attachmentService } = await setup();
    const token = await bootstrap(origin);
    const bytes = Buffer.from("duplicate-body");
    const digest = createHash("sha256").update(bytes).digest("hex");

    async function stageOne() {
      const created = await createPending(origin, token, "project-a", {
        expectedSizeBytes: bytes.byteLength,
        mediaType: "text/markdown",
        expectedDigestSha256: digest
      });
      const pendingUploadId = created.payload.pendingUploadId as string;
      await uploadPending(
        origin,
        token,
        "project-a",
        pendingUploadId,
        bytes,
        "text/markdown",
        digest
      );
      return pendingUploadId;
    }

    const first = await stageOne();
    const second = await stageOne();
    expect(first).not.toBe(second);

    const fin1 = await finalizePending(origin, token, "project-a", first, {
      pendingUploadId: first,
      digestSha256: digest,
      sizeBytes: bytes.byteLength,
      mediaType: "text/markdown"
    });
    const fin2 = await finalizePending(origin, token, "project-a", second, {
      pendingUploadId: second,
      digestSha256: digest,
      sizeBytes: bytes.byteLength,
      mediaType: "text/markdown"
    });
    expect(fin1.response.status).toBe(200);
    expect(fin2.response.status).toBe(200);

    // Idempotent re-finalize
    const again = await finalizePending(origin, token, "project-a", first, {
      pendingUploadId: first,
      digestSha256: digest,
      sizeBytes: bytes.byteLength,
      mediaType: "text/markdown"
    });
    expect(again.response.status).toBe(200);

    // Concurrent finalize race against a third staged upload: only first CAS wins from uploaded.
    const third = await stageOne();
    const actor = {
      humanPrincipalId: "human-owner-1",
      displayName: "Owner",
      deviceCredentialId: "ignored",
      projectId: "project-a",
      role: "owner" as const,
      membershipId: "ignored"
    };
    // Use service-level concurrent finalize after re-reading uploaded status via HTTP once.
    // Both calls should not throw uncaught; one may be idempotent success after first.
    const attachment = {
      pendingUploadId: third,
      digestSha256: digest,
      sizeBytes: bytes.byteLength,
      mediaType: "text/markdown" as const
    };
    const results = await Promise.allSettled([
      Promise.resolve(
        attachmentService.finalize({
          actor: { ...actor, deviceCredentialId: "d1", membershipId: "m1" },
          projectId: "project-a",
          attachment
        })
      ),
      Promise.resolve(
        attachmentService.finalize({
          actor: { ...actor, deviceCredentialId: "d1", membershipId: "m1" },
          projectId: "project-a",
          attachment
        })
      )
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
  });

  it("allows read of tombstoned comment attachments for members and cleans expired staged uploads", async () => {
    let now = new Date("2026-07-24T12:00:00.000Z");
    const { origin, attachmentService, directory } = await setup({ clock: () => now });
    const token = await bootstrap(origin);
    const memberToken = await inviteAndJoin(origin, token, "project-a", "Member One");
    const bytes = Buffer.from("tombstone-bytes");
    const digest = createHash("sha256").update(bytes).digest("hex");

    const created = await createPending(origin, token, "project-a", {
      expectedSizeBytes: bytes.byteLength,
      mediaType: "text/plain",
      expectedDigestSha256: digest,
      fileName: "keep.txt"
    });
    const pendingUploadId = created.payload.pendingUploadId as string;
    await uploadPending(origin, token, "project-a", pendingUploadId, bytes, "text/plain", digest);
    const finalized = await finalizePending(origin, token, "project-a", pendingUploadId, {
      pendingUploadId,
      digestSha256: digest,
      sizeBytes: bytes.byteLength,
      mediaType: "text/plain",
      fileName: "keep.txt"
    });
    const metadata = finalized.payload.attachment as {
      digestSha256: string;
      sizeBytes: number;
      mediaType: "text/plain";
      fileName?: string;
      createdAt: string;
    };

    const actor = {
      humanPrincipalId: "human-owner-1",
      displayName: "Owner",
      deviceCredentialId: "device",
      projectId: "project-a",
      role: "owner" as const,
      membershipId: "membership"
    };
    attachmentService.bindCommentAttachments({
      actor,
      projectId: "project-a",
      commentId: "comment-1",
      attachments: [metadata]
    });
    attachmentService.setCommentTombstoned({
      projectId: "project-a",
      commentId: "comment-1",
      tombstonedAt: now.toISOString()
    });

    const tombstonedRead = await fetch(
      `${origin}/api/v1/projects/project-a/attachments/comments/comment-1/${digest}`,
      { headers: auth(memberToken) }
    );
    expect(tombstonedRead.status).toBe(200);
    expect(Buffer.from(await tombstonedRead.arrayBuffer())).toEqual(bytes);

    // Cleanup: create an expired non-finalized upload and purge it.
    const ephemeral = await createPending(origin, token, "project-a", {
      expectedSizeBytes: 5,
      mediaType: "text/plain",
      expectedDigestSha256: createHash("sha256").update("gone!").digest("hex"),
      ttlMs: 60_000
    });
    const ephemeralId = ephemeral.payload.pendingUploadId as string;
    const ephemeralBytes = Buffer.from("gone!");
    await uploadPending(
      origin,
      token,
      "project-a",
      ephemeralId,
      ephemeralBytes,
      "text/plain",
      createHash("sha256").update(ephemeralBytes).digest("hex")
    );

    now = new Date("2026-07-24T14:00:00.000Z");
    const cleanup = await fetch(`${origin}/api/v1/projects/project-a/attachments/cleanup`, {
      method: "POST",
      headers: auth(token)
    });
    expect(cleanup.status).toBe(200);
    const cleanupPayload = (await cleanup.json()) as { removedPending: number };
    expect(cleanupPayload.removedPending).toBeGreaterThanOrEqual(1);

    // Finalized/bound blob remains.
    const boundRead = await fetch(
      `${origin}/api/v1/projects/project-a/attachments/by-digest/${digest}`,
      { headers: auth(token) }
    );
    expect(boundRead.status).toBe(200);

    // tmp directory should not accumulate staging files.
    await expect(readdir(join(directory, "comment-attachments", "tmp"))).resolves.toEqual([]);
  });

  it("does not let non-uploader members stream another member's pending body", async () => {
    const { origin } = await setup();
    const ownerToken = await bootstrap(origin);
    const memberToken = await inviteAndJoin(origin, ownerToken, "project-a", "Member Two");
    const bytes = Buffer.from("owner-only-upload");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const created = await createPending(origin, ownerToken, "project-a", {
      expectedSizeBytes: bytes.byteLength,
      mediaType: "text/plain",
      expectedDigestSha256: digest
    });
    const pendingUploadId = created.payload.pendingUploadId as string;
    const stolen = await uploadPending(
      origin,
      memberToken,
      "project-a",
      pendingUploadId,
      bytes,
      "text/plain",
      digest
    );
    expect(stolen.response.status).toBe(403);
    expect(stolen.payload.error).toBe("attachment_pending_not_uploader");
  });
});
