import type {
  ExecutionEnvelope,
  MailboxCommand,
  NormalizedFailure
} from "@planweave-ai/distributed-protocol";
import type { RemoteBlockDispatchCandidate, RemoteBlockRuntimePort } from "@planweave-ai/runtime";
import type { HostCapacityReservation } from "./hostReservations.js";
import type { MailboxMessage } from "./mailbox.js";
import type { RemoteOperation } from "./remoteOperations.js";

export type RemoteCoordinatorCheckpoint =
  | "before_operation_commit"
  | "after_operation_commit"
  | "after_runtime_claim"
  | "after_candidate_persistence"
  | "after_envelope_persistence"
  | "after_input_materialization"
  | "after_host_reservation"
  | "after_dispatch_persistence"
  | "after_runtime_binding"
  | "after_mailbox_enqueue"
  | "after_mailbox_publish"
  | "after_host_acceptance_observed"
  | "after_terminal_event_persistence"
  | "before_runtime_writeback"
  | "after_runtime_writeback"
  | "after_dispatch_terminal_persistence"
  | "after_terminal_persistence";

export interface RemoteCoordinatorCheckpointPort {
  reached(checkpoint: RemoteCoordinatorCheckpoint): void | Promise<void>;
}

export type RemoteRuntimeLocator = {
  projectId: string;
  canvasId: string;
};

export interface RemoteBlockRuntimeResolverPort {
  resolve(locator: RemoteRuntimeLocator): RemoteBlockRuntimePort;
}

export interface RemoteOperationCandidatePort {
  get(operationId: string): RemoteBlockDispatchCandidate | undefined;
  record(operationId: string, candidate: RemoteBlockDispatchCandidate): void;
}

export type ActivatedMailboxDelivery = {
  operation: RemoteOperation;
  message: MailboxMessage;
};

export type RemoteDispatchReconciliationState = {
  dispatch?: {
    status:
      | "leased"
      | "running"
      | "interrupted"
      | "cancelling"
      | "awaiting_writeback"
      | "completed"
      | "failed"
      | "cancelled";
    envelopeDigest?: string;
    inputGrantCount: number;
    terminalAction?:
      | { kind: "complete"; reportArtifactRef: string }
      | { kind: "fail"; failure: NormalizedFailure };
  };
  mailbox?: {
    messageId: string;
    publishedAt?: string;
  };
};

export interface RemoteDispatchPersistencePort {
  inspect(operation: RemoteOperation): RemoteDispatchReconciliationState;
  prepare(input: {
    operation: RemoteOperation;
    reservation: HostCapacityReservation;
    envelope: ExecutionEnvelope;
    envelopeDigest: string;
  }): void;
  activate(input: {
    operation: RemoteOperation;
    reservation: HostCapacityReservation;
    command: MailboxCommand;
  }): ActivatedMailboxDelivery;
  enqueueCancel(input: { operation: RemoteOperation; reason: string }): MailboxMessage;
  markMailboxPublished(messageId: string): void;
  finishTerminal(input: {
    operation: RemoteOperation;
    status: "completed" | "failed" | "cancelled";
  }): void;
}

export interface RemoteMailboxPublisherPort {
  publish(message: MailboxMessage): void;
}

export interface RemoteArtifactContentPort {
  readReport(artifactRef: string): Promise<Uint8Array>;
}

export interface RemoteInputArtifactPort {
  materialize(candidate: RemoteBlockDispatchCandidate): Promise<void>;
}
