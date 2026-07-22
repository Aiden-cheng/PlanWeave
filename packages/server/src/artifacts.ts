import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import { chmod, link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { artifactRefSchema } from "./protocol.js";
import type { SqliteDatabase } from "./sqlite.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const mediaTypeSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x20-\x7e]+$/);

const artifactRowSchema = z.object({
  ref: artifactRefSchema,
  sha256: sha256Schema,
  size_bytes: z.number().int().nonnegative(),
  media_type: mediaTypeSchema,
  relative_path: z.string().regex(/^[a-f0-9]{2}\/[a-f0-9]{64}$/),
  created_by_host_id: z.string().nullable(),
  created_at: z.string().datetime()
});

export type ArtifactMetadata = {
  ref: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  createdByHostId?: string;
  createdAt: string;
};

function artifactRef(sha256: string): string {
  return `artifact:sha256:${sha256Schema.parse(sha256)}`;
}

export class ArtifactStore {
  private readonly artifactsDirectory: string;
  private readonly temporaryDirectory: string;

  constructor(
    private readonly database: SqliteDatabase,
    dataDirectory: string,
    readonly maxArtifactBytes: number
  ) {
    if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1) {
      throw new Error("maxArtifactBytes must be a positive safe integer.");
    }
    this.artifactsDirectory = join(dataDirectory, "artifacts", "sha256");
    this.temporaryDirectory = join(dataDirectory, "artifacts", "tmp");
  }

  async put(input: {
    expectedSha256: string;
    expectedSizeBytes: number;
    mediaType: string;
    createdByHostId?: string;
    chunks: AsyncIterable<Uint8Array>;
  }): Promise<ArtifactMetadata> {
    const expectedSha256 = sha256Schema.parse(input.expectedSha256);
    const mediaType = mediaTypeSchema.parse(input.mediaType);
    if (
      !Number.isSafeInteger(input.expectedSizeBytes) ||
      input.expectedSizeBytes < 0 ||
      input.expectedSizeBytes > this.maxArtifactBytes
    ) {
      throw new Error("artifact_size_out_of_range");
    }
    await mkdir(this.temporaryDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.temporaryDirectory, 0o700);
    const temporaryPath = join(this.temporaryDirectory, randomUUID());
    const handle = await open(temporaryPath, "wx", 0o600);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    try {
      try {
        for await (const chunk of input.chunks) {
          sizeBytes += chunk.byteLength;
          if (sizeBytes > input.expectedSizeBytes || sizeBytes > this.maxArtifactBytes) {
            throw new Error("artifact_size_mismatch");
          }
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.byteLength) {
            const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
            if (bytesWritten < 1) throw new Error("artifact_write_stalled");
            offset += bytesWritten;
          }
        }
        await handle.sync();
      } finally {
        await handle.close();
      }

      if (sizeBytes !== input.expectedSizeBytes) throw new Error("artifact_size_mismatch");
      const actualSha256 = hash.digest("hex");
      if (actualSha256 !== expectedSha256) throw new Error("artifact_digest_mismatch");
      const relativePath = `${expectedSha256.slice(0, 2)}/${expectedSha256}`;
      const finalDirectory = join(this.artifactsDirectory, expectedSha256.slice(0, 2));
      const finalPath = join(finalDirectory, expectedSha256);
      await mkdir(finalDirectory, { recursive: true, mode: 0o700 });
      await chmod(finalDirectory, 0o700);
      try {
        await link(temporaryPath, finalPath);
        await chmod(finalPath, 0o600);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        if ((await stat(finalPath)).size !== sizeBytes) throw new Error("artifact_blob_conflict");
      }
      const ref = artifactRef(expectedSha256);
      const createdAt = new Date().toISOString();
      this.database
        .prepare(
          `INSERT INTO artifacts(
            ref,sha256,size_bytes,media_type,relative_path,created_by_host_id,created_at
          ) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(ref) DO NOTHING`
        )
        .run(
          ref,
          expectedSha256,
          sizeBytes,
          mediaType,
          relativePath,
          input.createdByHostId ?? null,
          createdAt
        );
      return this.getRequired(ref);
    } finally {
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      });
    }
  }

  get(ref: string): ArtifactMetadata | undefined {
    const parsedRef = artifactRefSchema.parse(ref);
    const raw = this.database.prepare("SELECT * FROM artifacts WHERE ref=?").get(parsedRef);
    if (!raw) return undefined;
    const row = artifactRowSchema.parse(raw);
    return {
      ref: row.ref,
      sha256: row.sha256,
      sizeBytes: row.size_bytes,
      mediaType: row.media_type,
      createdByHostId: row.created_by_host_id ?? undefined,
      createdAt: row.created_at
    };
  }

  getRequired(ref: string): ArtifactMetadata {
    const artifact = this.get(ref);
    if (!artifact) throw new Error("artifact_not_found");
    return artifact;
  }

  async read(ref: string): Promise<Buffer> {
    const metadata = this.getRequired(ref);
    const bytes = await readFile(
      join(this.artifactsDirectory, metadata.sha256.slice(0, 2), metadata.sha256)
    );
    if (bytes.byteLength !== metadata.sizeBytes) throw new Error("artifact_blob_size_mismatch");
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== metadata.sha256) throw new Error("artifact_blob_digest_mismatch");
    return bytes;
  }

  async openRead(ref: string): Promise<{ metadata: ArtifactMetadata; stream: ReadStream }> {
    const metadata = this.getRequired(ref);
    const path = join(this.artifactsDirectory, metadata.sha256.slice(0, 2), metadata.sha256);
    if ((await stat(path)).size !== metadata.sizeBytes)
      throw new Error("artifact_blob_size_mismatch");
    return { metadata, stream: createReadStream(path) };
  }
}
