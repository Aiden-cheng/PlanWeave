import {
  activeRemoteBlockOwnershipSchema,
  preparingRemoteBlockOwnershipSchema,
  remoteInterruptionSchema,
  remoteOperationReceiptSchema,
  type ActiveRemoteBlockOwnershipInput,
  type PreparingRemoteBlockOwnershipInput,
  type RemoteBlockOwnership,
  type RemoteInterruption,
  type RemoteOperationReceipt
} from "../schema/remoteOwnership.js";
import type { NormalizedFailure } from "@planweave-ai/distributed-protocol";
import type { BlockState, BlockStatus, BlockType } from "../types.js";

export type RemoteOwnershipConflictCode =
  | "remote_ownership_requires_implementation"
  | "remote_ownership_requires_ready_block"
  | "remote_ownership_operation_conflict"
  | "remote_ownership_source_conflict"
  | "remote_ownership_not_preparing"
  | "remote_ownership_activation_conflict"
  | "remote_ownership_not_active"
  | "remote_ownership_terminal_conflict"
  | "remote_ownership_status_conflict"
  | "remote_ownership_source_drift";

export class RemoteOwnershipConflictError extends Error {
  readonly code: RemoteOwnershipConflictCode;

  constructor(code: RemoteOwnershipConflictCode, message: string) {
    super(message);
    this.name = "RemoteOwnershipConflictError";
    this.code = code;
  }
}

function sameSource(
  owner: RemoteBlockOwnership,
  source: { operationId: string; sourceRevision: string; graphFingerprint: string }
): boolean {
  return (
    owner.operationId === source.operationId &&
    owner.sourceRevision === source.sourceRevision &&
    owner.graphFingerprint === source.graphFingerprint
  );
}

function assertImplementation(blockType: BlockType): void {
  if (blockType !== "implementation") {
    throw new RemoteOwnershipConflictError(
      "remote_ownership_requires_implementation",
      "Only implementation blocks may have remote ownership."
    );
  }
}

export function assertRemoteBlockOwnershipInvariant(options: {
  blockType: BlockType;
  blockState: BlockState;
}): void {
  if (!options.blockState.remoteOwnership) {
    return;
  }
  assertImplementation(options.blockType);
  if (options.blockState.status !== "in_progress" && options.blockState.status !== "diverged") {
    throw new RemoteOwnershipConflictError(
      "remote_ownership_status_conflict",
      `Remote ownership cannot be retained by a '${options.blockState.status}' block.`
    );
  }
}

export function assertSameRemoteOwnershipGeneration(
  owner: RemoteBlockOwnership,
  requested: { operationId: string; sourceRevision: string; graphFingerprint: string }
): void {
  if (owner.operationId !== requested.operationId) {
    throw new RemoteOwnershipConflictError(
      "remote_ownership_operation_conflict",
      `Remote operation '${requested.operationId}' conflicts with owner '${owner.operationId}'.`
    );
  }
  if (!sameSource(owner, requested)) {
    throw new RemoteOwnershipConflictError(
      "remote_ownership_source_conflict",
      `Remote operation '${requested.operationId}' does not match its recorded source evidence.`
    );
  }
}

export type ActiveRemoteOperationIdentity = Omit<ActiveRemoteBlockOwnershipInput, "phase">;

export function assertActiveRemoteBlockOwnership(options: {
  blockType: BlockType;
  blockState: BlockState;
  ownership: ActiveRemoteOperationIdentity;
}): RemoteBlockOwnership & { phase: "active" } {
  assertImplementation(options.blockType);
  assertRemoteBlockOwnershipInvariant(options);
  const requested = activeRemoteBlockOwnershipSchema.parse({
    phase: "active",
    ...options.ownership
  });
  const current = options.blockState.remoteOwnership;
  if (!current || current.phase !== "active") {
    throw new RemoteOwnershipConflictError(
      "remote_ownership_not_active",
      "The block is not bound to an active remote dispatch and execution attempt."
    );
  }
  assertSameRemoteOwnershipGeneration(current, requested);
  if (
    current.dispatchId !== requested.dispatchId ||
    current.executionAttemptId !== requested.executionAttemptId
  ) {
    throw new RemoteOwnershipConflictError(
      "remote_ownership_activation_conflict",
      `Remote operation '${requested.operationId}' is bound to another dispatch or attempt.`
    );
  }
  return current;
}

export function matchesRemoteOperationReceipt(
  receipt: RemoteOperationReceipt | undefined,
  identity: ActiveRemoteOperationIdentity
): boolean {
  return Boolean(
    receipt &&
      receipt.operationId === identity.operationId &&
      receipt.sourceRevision === identity.sourceRevision &&
      receipt.graphFingerprint === identity.graphFingerprint &&
      receipt.dispatchId === identity.dispatchId &&
      receipt.executionAttemptId === identity.executionAttemptId
  );
}

/**
 * Start one remote ownership generation. A local in-progress block cannot be retrofitted.
 * Replaying the same preparation is idempotent; a different operation or source conflicts.
 */
export function prepareRemoteBlockOwnership(options: {
  blockType: BlockType;
  blockState: BlockState;
  ownership: Omit<PreparingRemoteBlockOwnershipInput, "phase">;
}): BlockState {
  assertImplementation(options.blockType);
  assertRemoteBlockOwnershipInvariant(options);
  const requested = preparingRemoteBlockOwnershipSchema.parse({
    phase: "preparing",
    ...options.ownership
  });
  const current = options.blockState.remoteOwnership;
  if (current) {
    assertSameRemoteOwnershipGeneration(current, requested);
    return options.blockState;
  }
  if (options.blockState.status !== "ready") {
    throw new RemoteOwnershipConflictError(
      "remote_ownership_requires_ready_block",
      options.blockState.status === "in_progress"
        ? "A local in-progress block cannot be retroactively assigned a remote owner."
        : `A remote ownership generation requires a ready block, got '${options.blockState.status}'.`
    );
  }
  return {
    ...options.blockState,
    status: "in_progress",
    remoteOwnership: requested
  };
}

/** Activate exactly the dispatch/attempt produced for the preparing operation. */
export function activateRemoteBlockOwnership(options: {
  blockType: BlockType;
  blockState: BlockState;
  ownership: Omit<ActiveRemoteBlockOwnershipInput, "phase">;
}): BlockState {
  assertImplementation(options.blockType);
  assertRemoteBlockOwnershipInvariant(options);
  const requested = activeRemoteBlockOwnershipSchema.parse({
    phase: "active",
    ...options.ownership
  });
  const current = options.blockState.remoteOwnership;
  if (!current) {
    throw new RemoteOwnershipConflictError(
      "remote_ownership_not_preparing",
      "Remote ownership must be prepared before dispatch activation."
    );
  }
  assertSameRemoteOwnershipGeneration(current, requested);
  if (options.blockState.status !== "in_progress") {
    throw new RemoteOwnershipConflictError(
      "remote_ownership_not_preparing",
      `Remote ownership in '${options.blockState.status}' cannot be activated.`
    );
  }
  if (current.phase === "active") {
    if (
      current.dispatchId === requested.dispatchId &&
      current.executionAttemptId === requested.executionAttemptId
    ) {
      return options.blockState;
    }
    throw new RemoteOwnershipConflictError(
      "remote_ownership_activation_conflict",
      `Remote operation '${requested.operationId}' is already bound to another dispatch or attempt.`
    );
  }
  return { ...options.blockState, remoteOwnership: requested };
}

/**
 * Preserve exact ownership after package drift so late writes can still be rejected by identity.
 * Diverged ownership cannot be activated or otherwise advanced until explicitly resolved.
 */
export function markRemoteBlockOwnershipSourceDrift(options: {
  blockType: BlockType;
  blockState: BlockState;
  sourceRevision: string;
  graphFingerprint: string;
  reason: string;
}): BlockState {
  assertImplementation(options.blockType);
  assertRemoteBlockOwnershipInvariant(options);
  const owner = options.blockState.remoteOwnership;
  if (!owner) {
    return options.blockState;
  }
  const currentSource = preparingRemoteBlockOwnershipSchema.parse({
    phase: "preparing",
    operationId: owner.operationId,
    sourceRevision: options.sourceRevision,
    graphFingerprint: options.graphFingerprint
  });
  if (
    owner.sourceRevision === currentSource.sourceRevision &&
    owner.graphFingerprint === currentSource.graphFingerprint
  ) {
    return options.blockState;
  }
  const reason = options.reason.trim();
  if (!reason) {
    throw new RemoteOwnershipConflictError(
      "remote_ownership_source_drift",
      "Remote ownership source drift requires a non-empty reason."
    );
  }
  return {
    ...options.blockState,
    status: "diverged",
    divergenceReason: reason,
    remoteOwnership: owner,
    remoteInterruption: undefined
  };
}

export function interruptRemoteBlockOwnership(options: {
  blockType: BlockType;
  blockState: BlockState;
  ownership: ActiveRemoteOperationIdentity;
  interruption: RemoteInterruption;
  reason: string;
}): BlockState {
  assertActiveRemoteBlockOwnership(options);
  const interruption = remoteInterruptionSchema.parse(options.interruption);
  const reason = options.reason.trim();
  if (!reason) {
    throw new RemoteOwnershipConflictError(
      "remote_ownership_status_conflict",
      "Remote interruption requires a non-empty public reason."
    );
  }
  if (options.blockState.status === "diverged") {
    if (
      options.blockState.remoteInterruption?.reason === interruption.reason &&
      options.blockState.remoteInterruption.resumable === interruption.resumable &&
      options.blockState.divergenceReason === reason
    ) {
      return options.blockState;
    }
    throw new RemoteOwnershipConflictError(
      "remote_ownership_terminal_conflict",
      "The remote operation is already diverged for a different reason."
    );
  }
  if (options.blockState.status !== "in_progress") {
    throw new RemoteOwnershipConflictError(
      "remote_ownership_status_conflict",
      `Remote interruption cannot be recorded from '${options.blockState.status}'.`
    );
  }
  return {
    ...options.blockState,
    status: "diverged",
    divergenceReason: reason,
    remoteInterruption: interruption
  };
}

export function completeRemoteBlockOwnership(options: {
  blockType: BlockType;
  blockState: BlockState;
  ownership: ActiveRemoteOperationIdentity;
  runId: string;
}): BlockState {
  assertActiveRemoteBlockOwnership(options);
  const receipt = remoteOperationReceiptSchema.parse({
    outcome: "completed",
    ...options.ownership,
    runId: options.runId
  });
  const cleared = withoutRemoteBlockOwnership(options.blockState, "completed");
  return { ...cleared, lastRunId: options.runId, remoteOperationReceipt: receipt };
}

export function failRemoteBlockOwnership(options: {
  blockType: BlockType;
  blockState: BlockState;
  ownership: ActiveRemoteOperationIdentity;
  failure: NormalizedFailure;
  blockedReason: string;
}): BlockState {
  assertActiveRemoteBlockOwnership(options);
  const receipt = remoteOperationReceiptSchema.parse({
    outcome: "failed",
    ...options.ownership,
    failure: options.failure
  });
  const cleared = withoutRemoteBlockOwnership(options.blockState, "blocked");
  return {
    ...cleared,
    blockedReason: options.blockedReason,
    remoteOperationReceipt: receipt
  };
}

/** Remove ownership whenever a mutation leaves remote execution lifecycle control. */
export function withoutRemoteBlockOwnership(
  blockState: BlockState,
  status: Exclude<BlockStatus, "in_progress" | "diverged">
): BlockState {
  const rest = clearRemoteBlockOperationState(blockState);
  return { ...rest, status };
}

export function clearRemoteBlockOperationState(blockState: BlockState): BlockState {
  const {
    remoteOwnership: _remoteOwnership,
    remoteInterruption: _remoteInterruption,
    remoteOperationReceipt: _remoteOperationReceipt,
    ...rest
  } = blockState;
  return rest;
}
