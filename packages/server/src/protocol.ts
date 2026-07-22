import { z } from "zod";

export const agentHostProtocolVersion = 1 as const;

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const capabilitySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/);

export const capabilitiesSchema = z
  .array(capabilitySchema)
  .max(128)
  .transform((values) => [...new Set(values)]);

export const dispatchResultSchema = z.object({
  summary: z.string().max(16384),
  artifactRefs: z.array(z.string().min(1).max(4096)).max(256).default([])
});

export const dispatchFailureSchema = z.object({
  code: identifierSchema,
  message: z.string().min(1).max(16384),
  retryable: z.boolean()
});

const hostEventBaseSchema = z.object({
  messageId: identifierSchema
});

export const hostHelloSchema = z.object({
  type: z.literal("host.hello"),
  protocolVersion: z.literal(agentHostProtocolVersion),
  lastAcknowledgedSequence: z.number().int().nonnegative(),
  capabilities: capabilitiesSchema,
  capacity: z.number().int().min(1).max(128)
});

export const hostEventSchema = z.discriminatedUnion("type", [
  hostEventBaseSchema.extend({
    type: z.literal("mailbox.ack"),
    sequence: z.number().int().positive()
  }),
  hostEventBaseSchema.extend({
    type: z.literal("host.heartbeat"),
    activeLeases: z
      .array(
        z.object({
          dispatchId: identifierSchema,
          leaseId: identifierSchema
        })
      )
      .max(128)
  }),
  hostEventBaseSchema.extend({
    type: z.literal("dispatch.accepted"),
    dispatchId: identifierSchema,
    leaseId: identifierSchema
  }),
  hostEventBaseSchema.extend({
    type: z.literal("dispatch.progress"),
    dispatchId: identifierSchema,
    leaseId: identifierSchema,
    percent: z.number().min(0).max(100).optional(),
    message: z.string().max(4096).optional()
  }),
  hostEventBaseSchema.extend({
    type: z.literal("dispatch.completed"),
    dispatchId: identifierSchema,
    leaseId: identifierSchema,
    result: dispatchResultSchema
  }),
  hostEventBaseSchema.extend({
    type: z.literal("dispatch.failed"),
    dispatchId: identifierSchema,
    leaseId: identifierSchema,
    failure: dispatchFailureSchema
  })
]);

const executeBlockCommandSchema = z.object({
  type: z.literal("execute_block"),
  dispatchId: identifierSchema,
  leaseId: identifierSchema,
  leaseExpiresAt: z.string().datetime(),
  projectId: identifierSchema,
  blockRef: z
    .string()
    .min(3)
    .max(256)
    .regex(/^[^#\s]+#[^#\s]+$/),
  packageRef: z.string().min(1).max(4096),
  requiredCapabilities: capabilitiesSchema
});

const cancelExecutionCommandSchema = z.object({
  type: z.literal("cancel_execution"),
  dispatchId: identifierSchema,
  leaseId: identifierSchema,
  reason: z.string().min(1).max(4096)
});

export const mailboxCommandSchema = z.discriminatedUnion("type", [
  executeBlockCommandSchema,
  cancelExecutionCommandSchema
]);

export const serverEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("host.welcome"),
    protocolVersion: z.literal(agentHostProtocolVersion),
    serverTime: z.string().datetime(),
    heartbeatIntervalMs: z.number().int().positive(),
    leaseDurationMs: z.number().int().positive()
  }),
  z.object({
    type: z.literal("mailbox.message"),
    sequence: z.number().int().positive(),
    messageId: identifierSchema,
    command: mailboxCommandSchema
  }),
  z.object({
    type: z.literal("host.event_ack"),
    messageId: identifierSchema
  }),
  z.object({
    type: z.literal("lease.renewed"),
    dispatchId: identifierSchema,
    leaseId: identifierSchema,
    leaseExpiresAt: z.string().datetime()
  }),
  z.object({
    type: z.literal("protocol.error"),
    code: identifierSchema,
    message: z.string().min(1).max(4096),
    messageId: identifierSchema.optional()
  })
]);

export type HostHello = z.infer<typeof hostHelloSchema>;
export type HostEvent = z.infer<typeof hostEventSchema>;
export type MailboxCommand = z.infer<typeof mailboxCommandSchema>;
export type ServerEvent = z.infer<typeof serverEventSchema>;
export type ProtocolDispatchResult = z.infer<typeof dispatchResultSchema>;
export type ProtocolDispatchFailure = z.infer<typeof dispatchFailureSchema>;
