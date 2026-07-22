import {
  markBlockBlocked,
  submitBlockResultFromBytes,
  type PackageWorkspaceRef
} from "@planweave-ai/runtime";
import { ArtifactStore } from "./artifacts.js";
import type { DispatchWriteback } from "./dispatches.js";

export type PlanPackageWritebackOptions = {
  artifacts: ArtifactStore;
  resolvePackageRef(packageRef: string): PackageWorkspaceRef | Promise<PackageWorkspaceRef>;
};

export function createPlanPackageDispatchWriteback(
  options: PlanPackageWritebackOptions
): DispatchWriteback {
  return {
    complete: async (input) => {
      const artifact = options.artifacts.getRequired(input.result.reportArtifactRef);
      if (artifact.mediaType.split(";", 1)[0]?.trim().toLowerCase() !== "text/markdown") {
        throw new Error("dispatch_report_must_be_markdown");
      }
      const reportBytes = await options.artifacts.read(artifact.ref);
      const projectRoot = await options.resolvePackageRef(input.packageRef);
      await submitBlockResultFromBytes(
        {
          projectRoot,
          ref: input.blockRef,
          reportPath: artifact.ref
        },
        reportBytes
      );
    },
    fail: async (input) => {
      const projectRoot = await options.resolvePackageRef(input.packageRef);
      await markBlockBlocked({
        projectRoot,
        ref: input.blockRef,
        reason: `[${input.failure.code}] ${input.failure.message}`
      });
    }
  };
}
