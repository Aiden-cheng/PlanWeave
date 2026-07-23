import type {
  DispatchResult as ProtocolDispatchResult,
  HostEvent,
  NormalizedFailure as ProtocolDispatchFailure,
  ServerEvent
} from "../protocol.js";
import type { AgentHostExecution, CancelExecutionCommand } from "./agentHostStateRecords.js";

export type AgentHostCancellation = {
  sequence: number;
  messageId: string;
  command: CancelExecutionCommand;
};

export type AgentHostStateLimits = {
  readonly maxPendingCommands: number;
  readonly maxPendingEvents: number;
};

export const DEFAULT_AGENT_HOST_STATE_LIMITS: AgentHostStateLimits = {
  maxPendingCommands: 1_024,
  maxPendingEvents: 2_048
};

export interface AgentHostStateRepository {
  close(): void;
  receive(input: ServerEvent): { stored: boolean; acknowledgement: HostEvent };
  lastAcknowledgedSequence(): number;
  pendingEvents(limit?: number): HostEvent[];
  pendingEventCount(): number;
  queueHeartbeat(
    activeLeases: ReadonlyArray<{
      dispatchId: string;
      leaseId: string;
      executionAttemptId: string;
    }>
  ): HostEvent;
  acknowledgeEvent(messageId: string): boolean;
  recoverInterruptedExecutions(): number;
  recoverableExecutionCount(): number;
  pendingExecutions(limit: number): AgentHostExecution[];
  activeLeases(): Array<{
    dispatchId: string;
    leaseId: string;
    executionAttemptId: string;
  }>;
  renewLease(
    dispatchId: string,
    leaseId: string,
    executionAttemptId: string,
    leaseExpiresAt: string
  ): boolean;
  abandonExpiredExecutions(now: Date): AgentHostExecution[];
  pendingCancellations(): AgentHostCancellation[];
  applyCancellation(sequence: number): { shouldAbort: boolean };
  startExecution(sequence: number): AgentHostExecution | undefined;
  completeExecution(sequence: number, result: ProtocolDispatchResult): void;
  failExecution(sequence: number, failure: ProtocolDispatchFailure): void;
}
