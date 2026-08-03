import { z } from "zod";
import { opaqueIdentifierSchema } from "./identifiers.js";
import { dispatchLifecycleIdentitySchema } from "./lifecycle.js";
import { acpRecoveryIdentitySchema } from "./lifecycle.js";

export const INTERACTION_TEXT_MAX_LENGTH = 16_384 as const;
export const INTERACTION_OPTION_MAX_COUNT = 64 as const;

export const interactionActionIdSchema = opaqueIdentifierSchema.brand("InteractionActionId");

const interactionIdentitySchema = dispatchLifecycleIdentitySchema.extend({
  actionId: interactionActionIdSchema,
  acpSessionId: acpRecoveryIdentitySchema.shape.acpSessionId
});
const interactionRequestIdentitySchema = interactionIdentitySchema.extend({
  expiresAt: z.string().datetime()
});

export const interactionRequestSchema = z.discriminatedUnion("type", [
  interactionRequestIdentitySchema.extend({
    type: z.literal("interaction.permission_requested"),
    title: z.string().min(1).max(512),
    description: z.string().max(INTERACTION_TEXT_MAX_LENGTH)
  }),
  interactionRequestIdentitySchema.extend({
    type: z.literal("interaction.elicitation_requested"),
    prompt: z.string().min(1).max(INTERACTION_TEXT_MAX_LENGTH),
    options: z.array(z.string().min(1).max(512)).max(INTERACTION_OPTION_MAX_COUNT)
  }),
  interactionRequestIdentitySchema.extend({
    type: z.literal("interaction.authentication_required"),
    agentProfileId: opaqueIdentifierSchema,
    hostInstruction: z.string().min(1).max(INTERACTION_TEXT_MAX_LENGTH)
  })
]);

export const interactionSettlementSchema = z.discriminatedUnion("type", [
  interactionIdentitySchema.extend({
    type: z.literal("interaction.permission_response"),
    decision: z.enum(["allow_once", "deny"])
  }),
  interactionIdentitySchema
    .extend({
      type: z.literal("interaction.elicitation_response"),
      outcome: z.enum(["accepted", "cancelled"]),
      response: z.string().max(INTERACTION_TEXT_MAX_LENGTH).optional()
    })
    .superRefine((settlement, context) => {
      if (settlement.outcome === "accepted" && settlement.response === undefined) {
        context.addIssue({
          code: "custom",
          path: ["response"],
          message: "Accepted elicitation requires a response."
        });
      }
      if (settlement.outcome === "cancelled" && settlement.response !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["response"],
          message: "Cancelled elicitation must not include a response."
        });
      }
    }),
  interactionIdentitySchema.extend({
    type: z.literal("interaction.authentication_action"),
    action: z.enum(["retry_after_host_login", "cancel"])
  })
]);

export type InteractionActionId = z.infer<typeof interactionActionIdSchema>;
export type InteractionRequest = z.infer<typeof interactionRequestSchema>;
export type InteractionSettlement = z.infer<typeof interactionSettlementSchema>;

const settlementTypeByRequestType = {
  "interaction.permission_requested": "interaction.permission_response",
  "interaction.elicitation_requested": "interaction.elicitation_response",
  "interaction.authentication_required": "interaction.authentication_action"
} as const;

export function parseInteractionSettlementForRequest(
  requestInput: unknown,
  settlementInput: unknown
): InteractionSettlement {
  const request = interactionRequestSchema.parse(requestInput);
  const settlement = interactionSettlementSchema.parse(settlementInput);
  if (
    request.dispatchId !== settlement.dispatchId ||
    request.leaseId !== settlement.leaseId ||
    request.executionAttemptId !== settlement.executionAttemptId ||
    request.actionId !== settlement.actionId ||
    request.acpSessionId !== settlement.acpSessionId
  ) {
    throw new Error("interaction_identity_mismatch");
  }
  if (settlement.type !== settlementTypeByRequestType[request.type]) {
    throw new Error("interaction_response_type_mismatch");
  }
  return settlement;
}
