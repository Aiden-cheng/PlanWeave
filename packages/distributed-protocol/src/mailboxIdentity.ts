import { z } from "zod";
import { opaqueIdentifierSchema } from "./identifiers.js";

/** Idempotent identity of one durable mailbox message. */
export const mailboxMessageIdSchema = opaqueIdentifierSchema.brand("MailboxMessageId");

export type MailboxMessageId = z.infer<typeof mailboxMessageIdSchema>;

/**
 * Monotonic mailbox sequence cursor.
 * Zero is valid for "no messages acknowledged yet".
 */
export const mailboxSequenceSchema = z.number().int().nonnegative().safe();

export type MailboxSequence = z.infer<typeof mailboxSequenceSchema>;

/** Positive sequence assigned to a delivered mailbox message. */
export const mailboxDeliveredSequenceSchema = z.number().int().positive().safe();

export type MailboxDeliveredSequence = z.infer<typeof mailboxDeliveredSequenceSchema>;

/** Mailbox delivery identity for acknowledgements and replay. */
export const mailboxIdentitySchema = z
  .object({
    messageId: mailboxMessageIdSchema,
    sequence: mailboxDeliveredSequenceSchema
  })
  .strict();

export type MailboxIdentity = z.infer<typeof mailboxIdentitySchema>;
