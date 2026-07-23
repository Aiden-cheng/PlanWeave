import type {
  ArtifactRef,
  DispatchResult,
  NormalizedFailure,
  ServerToHostCommand
} from "../protocol.js";
import {
  normalizedFailureSchema,
  type ArtifactMediaType
} from "@planweave-ai/distributed-protocol";

export type AgentHostExecuteCommand = Extract<ServerToHostCommand, { type: "execute_block" }>;

export type AgentHostArtifactInput = {
  bytes: Uint8Array;
  mediaType: ArtifactMediaType;
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

export class AgentHostExecutionError extends Error {
  readonly failure: NormalizedFailure;

  constructor(failure: NormalizedFailure) {
    const parsed = normalizedFailureSchema.parse(failure);
    super(parsed.message);
    this.failure = parsed;
    this.name = "AgentHostExecutionError";
  }
}

export interface AgentHostExecutor {
  execute(
    command: AgentHostExecuteCommand,
    context: AgentHostExecutionContext
  ): Promise<DispatchResult>;
}
