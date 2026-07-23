import type { ArtifactRef, DispatchResult, ServerToHostCommand } from "../protocol.js";

export type AgentHostExecuteCommand = Extract<ServerToHostCommand, { type: "execute_block" }>;

export type AgentHostArtifactInput = {
  bytes: Uint8Array;
  mediaType: string;
  purpose: "report" | "output";
  operationKey: string;
};

/** Artifact transfer already bound to the active dispatch and lease. */
export interface AgentHostArtifactTransfer {
  upload(input: AgentHostArtifactInput): Promise<ArtifactRef>;
}

export type AgentHostExecutionContext = {
  signal: AbortSignal;
  executionKey: string;
  artifacts: AgentHostArtifactTransfer;
};

export interface AgentHostExecutor {
  execute(
    command: AgentHostExecuteCommand,
    context: AgentHostExecutionContext
  ): Promise<DispatchResult>;
}
