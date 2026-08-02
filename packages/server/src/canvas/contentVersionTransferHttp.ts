import { createHash } from "node:crypto";
import {
  contentVersionTransferCompleteFrameSchema,
  contentVersionTransferHeaderFrameSchema,
  contentVersionTransferLimits,
  contentVersionTransferMediaType,
  compareContentVersionMemberPaths,
  type CompletedContentVersionRef
} from "@planweave-ai/collaboration-contracts";
import type { CanvasScopeKey } from "./repository.js";
import { ContentVersionRepository } from "./contentVersionRepository.js";

type ContentVersionTransferResponse = {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: Uint8Array): boolean;
  end(): void;
  destroyed?: boolean;
  writableEnded?: boolean;
  writableFinished?: boolean;
  once(event: "drain" | "close" | "error", listener: (error?: Error) => void): unknown;
  off(event: "drain" | "close" | "error", listener: (error?: Error) => void): unknown;
};

type ContentVersionTransferRepository = Pick<ContentVersionRepository, "openTransfer">;

function encodedFrame(frame: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
  if (bytes.byteLength > contentVersionTransferLimits.maxFrameBytes) {
    throw new Error("content_transfer_frame_too_large");
  }
  return bytes;
}

function isResponseClosed(response: ContentVersionTransferResponse): boolean {
  return response.destroyed === true || response.writableEnded === true || response.writableFinished === true;
}

async function writeFrame(
  response: ContentVersionTransferResponse,
  frame: unknown,
  state: { wireBytes: number }
) {
  if (isResponseClosed(response)) throw new Error("content_transfer_client_disconnected");
  const bytes = encodedFrame(frame);
  state.wireBytes += bytes.byteLength;
  if (state.wireBytes > contentVersionTransferLimits.maxWireBytes) {
    throw new Error("content_transfer_wire_too_large");
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let writeCompleted = false;
    let drainSeen = false;
    const cleanup = () => {
      response.off("drain", drained);
      response.off("close", closed);
      response.off("error", failed);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const drained = () => {
      drainSeen = true;
      if (writeCompleted) succeed();
    };
    const closed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("content_transfer_client_disconnected"));
    };
    const failed = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error ?? new Error("content_transfer_write_failed"));
    };
    response.once("drain", drained);
    response.once("close", closed);
    response.once("error", failed);
    if (isResponseClosed(response)) {
      closed();
      return;
    }
    try {
      const requiresDrain = !response.write(bytes);
      if (isResponseClosed(response)) {
        closed();
        return;
      }
      writeCompleted = true;
      if (!requiresDrain || drainSeen) succeed();
    } catch (error) {
      failed(error instanceof Error ? error : new Error("content_transfer_write_failed"));
    }
  });
}

function validateTransfer(input: ReturnType<ContentVersionTransferRepository["openTransfer"]>): void {
  const header = contentVersionTransferHeaderFrameSchema.parse(input.header);
  let index = 0;
  let totalBytes = 0;
  let previousPath: string | undefined;
  for (const member of input.members) {
    if (
      previousPath !== undefined &&
      compareContentVersionMemberPaths(previousPath, member.path) >= 0
    ) {
      throw new Error("content_transfer_member_order_invalid");
    }
    const actualSize = Buffer.byteLength(member.content, "utf8");
    if (actualSize !== member.sizeBytes) throw new Error("content_transfer_member_size_invalid");
    if (createHash("sha256").update(member.content, "utf8").digest("hex") !== member.digestSha256) {
      throw new Error("content_transfer_member_digest_invalid");
    }
    totalBytes += actualSize;
    if (totalBytes > header.totalBytes) throw new Error("content_transfer_total_bytes_invalid");
    previousPath = member.path;
    index += 1;
  }
  if (index !== header.memberCount || totalBytes !== header.totalBytes) {
    throw new Error("content_transfer_complete_invalid");
  }
}

/** Server adapter for the immutable content transfer seam. It frames and bounds one member at a time. */
export async function streamContentVersion(
  response: ContentVersionTransferResponse,
  repository: ContentVersionTransferRepository,
  scope: CanvasScopeKey,
  content: CompletedContentVersionRef
): Promise<void> {
  const transfer = repository.openTransfer(scope, content);
  const header = contentVersionTransferHeaderFrameSchema.parse(transfer.header);
  // Validate the persisted stream before sending a header so rejected transfers remain redacted HTTP errors.
  validateTransfer(transfer);
  const stream = repository.openTransfer(scope, content);
  response.writeHead(200, {
    "content-type": `${contentVersionTransferMediaType}; charset=utf-8`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  const state = { wireBytes: 0 };
  await writeFrame(response, header, state);
  let index = 0;
  let totalBytes = 0;
  for (const member of stream.members) {
    totalBytes += member.sizeBytes;
    await writeFrame(response, { type: "member", index, member }, state);
    index += 1;
  }
  if (index !== header.memberCount || totalBytes !== header.totalBytes) {
    throw new Error("content_transfer_complete_invalid");
  }
  await writeFrame(
    response,
    contentVersionTransferCompleteFrameSchema.parse({
      type: "complete",
      canonicalDigest: header.canonicalDigest,
      totalBytes,
      memberCount: index
    }),
    state
  );
  response.end();
}
