import type {
  ApplyAuthorizedCanvasCommandInput,
  ApplyAuthorizedCanvasCommandResult
} from "@planweave-ai/runtime";

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
    }
  };
}
