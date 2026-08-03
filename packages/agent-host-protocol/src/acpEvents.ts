import { z } from "zod";
import { dispatchLifecycleIdentitySchema } from "./lifecycle.js";
import { acpRecoveryIdentitySchema } from "./lifecycle.js";

export const ACP_EVENT_BATCH_MAX_COUNT = 128 as const;
export const ACP_EVENT_TEXT_MAX_LENGTH = 16_384 as const;

export const acpEventCursorSchema = z.number().int().nonnegative().safe();
const deliveredAcpEventCursorSchema = z.number().int().positive().safe();

export const normalizedAcpEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      cursor: deliveredAcpEventCursorSchema,
      kind: z.literal("agent_message"),
      text: z.string().max(ACP_EVENT_TEXT_MAX_LENGTH)
    })
    .strict(),
  z
    .object({
      cursor: deliveredAcpEventCursorSchema,
      kind: z.literal("tool_call"),
      title: z.string().min(1).max(512),
      status: z.enum(["pending", "running", "completed", "failed"])
    })
    .strict(),
  z
    .object({
      cursor: deliveredAcpEventCursorSchema,
      kind: z.literal("plan"),
      text: z.string().max(ACP_EVENT_TEXT_MAX_LENGTH)
    })
    .strict(),
  z
    .object({
      cursor: deliveredAcpEventCursorSchema,
      kind: z.literal("diagnostic"),
      severity: z.enum(["info", "warning", "error"]),
      message: z.string().max(ACP_EVENT_TEXT_MAX_LENGTH)
    })
    .strict()
]);

export const normalizedAcpEventBatchSchema = dispatchLifecycleIdentitySchema
  .extend({
    type: z.literal("acp.events"),
    acpSessionId: acpRecoveryIdentitySchema.shape.acpSessionId,
    afterCursor: acpEventCursorSchema,
    cursor: acpEventCursorSchema,
    events: z.array(normalizedAcpEventSchema).min(1).max(ACP_EVENT_BATCH_MAX_COUNT)
  })
  .superRefine((batch, context) => {
    let expected = batch.afterCursor + 1;
    for (const event of batch.events) {
      if (event.cursor !== expected) {
        context.addIssue({
          code: "custom",
          message: "ACP event cursors must be contiguous and monotonic.",
          path: ["events"]
        });
        return;
      }
      expected += 1;
    }
    if (batch.cursor !== expected - 1) {
      context.addIssue({
        code: "custom",
        message: "Batch cursor must equal the final event cursor.",
        path: ["cursor"]
      });
    }
  });

export type AcpEventCursor = z.infer<typeof acpEventCursorSchema>;
export type NormalizedAcpEvent = z.infer<typeof normalizedAcpEventSchema>;
export type NormalizedAcpEventBatch = z.infer<typeof normalizedAcpEventBatchSchema>;
