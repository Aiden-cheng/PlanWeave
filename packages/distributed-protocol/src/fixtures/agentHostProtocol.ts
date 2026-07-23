import { hostEventSchema, hostHelloSchema, serverEventSchema } from "../agentHostProtocol.js";
import { executionEnvelopeSchema } from "../executionEnvelope.js";
import { interactionSettlementSchema } from "../interactions.js";
import {
  exampleExecutionEnvelopeDigest,
  exampleExecutionEnvelopeInput
} from "./executionEnvelope.js";

const protocolVersion = 1 as const;
const envelope = executionEnvelopeSchema.parse(exampleExecutionEnvelopeInput);
const dispatchId = envelope.execution.dispatchId;
const executionAttemptId = envelope.execution.attemptId;
const leaseId = "lease-demo-001";

export const exampleHostHello = hostHelloSchema.parse({
  type: "host.hello",
  protocolVersion,
  lastAcknowledgedSequence: 0,
  lastObservedAcpCursor: 0,
  capabilities: ["acp.codex", "workspace.git"],
  capacity: 2
});

export const exampleExecuteDelivery = serverEventSchema.parse({
  type: "mailbox.message",
  protocolVersion,
  sequence: 1,
  messageId: "mailbox-execute-001",
  command: {
    type: "execute_block",
    protocolVersion,
    dispatchId,
    leaseId,
    executionAttemptId,
    leaseExpiresAt: "2030-01-01T00:00:00.000Z",
    envelopeDigest: exampleExecutionEnvelopeDigest,
    envelope
  }
});

export const exampleResumeDelivery = serverEventSchema.parse({
  type: "mailbox.message",
  protocolVersion,
  sequence: 2,
  messageId: "mailbox-resume-001",
  command: {
    type: "resume_execution",
    protocolVersion,
    dispatchId,
    leaseId,
    executionAttemptId,
    priorRecovery: { acpSessionId: "acp-session-001", recoveryId: "recovery-001" },
    leaseExpiresAt: "2030-01-01T00:05:00.000Z"
  }
});

export const exampleAcpEventBatch = hostEventSchema.parse({
  type: "acp.events",
  protocolVersion,
  messageId: "host-event-acp-001",
  dispatchId,
  leaseId,
  executionAttemptId,
  afterCursor: 0,
  cursor: 2,
  events: [
    { cursor: 1, kind: "agent_message", text: "Starting the assigned block." },
    { cursor: 2, kind: "tool_call", title: "Run focused tests", status: "running" }
  ]
});

export const exampleInterruptedEvent = hostEventSchema.parse({
  type: "dispatch.interrupted",
  protocolVersion,
  messageId: "host-event-interrupted-001",
  dispatchId,
  leaseId,
  executionAttemptId,
  reason: "host_restart",
  resumable: true,
  recovery: { acpSessionId: "acp-session-001", recoveryId: "recovery-001" }
});

export const exampleAuthenticationRequired = hostEventSchema.parse({
  type: "interaction.authentication_required",
  protocolVersion,
  messageId: "host-event-auth-001",
  dispatchId,
  leaseId,
  executionAttemptId,
  actionId: "action-auth-001",
  agentProfileId: "acp.codex",
  hostInstruction: "Sign in through the Agent Host's local provider UI."
});

export const exampleAuthenticationSettlement = interactionSettlementSchema.parse({
  type: "interaction.authentication_action",
  dispatchId,
  leaseId,
  executionAttemptId,
  actionId: "action-auth-001",
  action: "retry_after_host_login"
});

export const agentHostProtocolGoldenFixtures = {
  hello: exampleHostHello,
  executeDelivery: exampleExecuteDelivery,
  resumeDelivery: exampleResumeDelivery,
  acpEventBatch: exampleAcpEventBatch,
  interrupted: exampleInterruptedEvent,
  authenticationRequired: exampleAuthenticationRequired,
  authenticationSettlement: exampleAuthenticationSettlement
} as const;
