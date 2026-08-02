import type {
  ApplyAuthorizedCanvasCommandInput,
  ApplyAuthorizedCanvasCommandResult
} from "@planweave-ai/runtime";
import {
  type CanvasRuntimeStatusProjection,
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
    authorityProjectId?: string;
  }): Promise<ApplyAuthorizedCanvasCommandResult>;
  captureContent?(input: {
    projectRoot: string;
    canvasId: string;
    expectedPackageDir: string;
    authorityProjectId?: string;
  }): Promise<{ ok: true; content: CompleteContentVersion } | { ok: false; detail: string }>;
  readStatus?(input: {
    projectRoot: string;
    canvasId: string;
    expectedPackageDir: string;
    scope: CanvasRuntimeStatusProjection["scope"];
    capturedAt?: string;
  }): Promise<CanvasRuntimeStatusProjection>;
};

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
        const captured = await runtime.captureAuthorizedCanvasContent({
          projectRoot: input.projectRoot,
          canvasId: input.canvasId,
          expectedPackageDir: input.expectedPackageDir,
          authorityProjectId: input.authorityProjectId
        });
        return { ok: true, content: captured.content };
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message.slice(0, 200) : "content_capture_failed" };
      }
    },
    async readStatus(input) {
      const runtime = await import("@planweave-ai/runtime");
      return runtime.readAuthorizedCanvasRuntimeStatus(input);
    }
  };
}
