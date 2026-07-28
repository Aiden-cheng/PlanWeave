import type {
  ApplyAuthorizedCanvasCommandInput,
  ApplyAuthorizedCanvasCommandResult
} from "@planweave-ai/runtime";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  canonicalContentVersionDigestPayload,
  completeContentVersionSchema,
  type CompleteContentVersion
} from "@planweave-ai/collaboration-contracts";

/**
 * Server-side port to Runtime graph mutation. Implementations must not re-parse
 * Plan Packages outside Runtime; only call the narrow authorized adapter.
 */
export type CanvasRuntimeMutationPort = {
  apply(input: ApplyAuthorizedCanvasCommandInput): Promise<ApplyAuthorizedCanvasCommandResult>;
  readDigest(input: {
    projectRoot: string;
    canvasId: string;
    expectedPackageDir?: string;
  }): Promise<ApplyAuthorizedCanvasCommandResult>;
  captureContent?(input: {
    projectRoot: string;
    canvasId: string;
    expectedPackageDir: string;
  }): Promise<{ ok: true; content: CompleteContentVersion } | { ok: false; detail: string }>;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function createDefaultCanvasRuntimePort(): CanvasRuntimeMutationPort {
  // Lazy import keeps server unit tests free to inject fakes without loading Runtime.
  return {
    async apply(input) {
      const runtime = await import("@planweave-ai/runtime");
      return runtime.applyAuthorizedCanvasCommand(input);
    },
    async readDigest(input) {
      const runtime = await import("@planweave-ai/runtime");
      return runtime.readAuthorizedCanvasContentDigest(input);
    },
    async captureContent(input) {
      try {
        const runtime = await import("@planweave-ai/runtime");
        const captured = await runtime.capturePackageSnapshot({
          projectRoot: input.projectRoot,
          canvasId: input.canvasId
        });
        if (captured.resolvedPackageDir !== input.expectedPackageDir) {
          return { ok: false, detail: "runtime_package_location_mismatch" };
        }
        const layout = await readFile(join(dirname(captured.resolvedPackageDir), "desktop", "layout.json"), "utf8");
        const members = [
          ...captured.snapshot.files.map((file) => ({
            kind: file.path === "manifest.json" ? "manifest" as const : file.path.includes("/blocks/") ? "block_prompt" as const : "task_prompt" as const,
            path: file.path,
            content: file.content,
            digestSha256: file.digestSha256,
            sizeBytes: file.sizeBytes
          })),
          { kind: "desktop_layout" as const, path: "desktop/layout.json", content: layout, digestSha256: sha256(layout), sizeBytes: Buffer.byteLength(layout, "utf8") }
        ].sort((left, right) => left.path.localeCompare(right.path));
        const totalBytes = members.reduce((sum, member) => sum + member.sizeBytes, 0);
        const canonicalDigest = sha256(canonicalContentVersionDigestPayload({ members, canonicalDigest: "0".repeat(64), totalBytes }));
        return { ok: true, content: completeContentVersionSchema.parse({ members, canonicalDigest, totalBytes }) };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message.slice(0, 200) : "content_capture_failed" };
      }
    }
  };
}
