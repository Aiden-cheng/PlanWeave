import { z } from "zod";
import {
  collaborationBoundaryErrorSchema,
  type CollaborationBoundaryErrorKind
} from "@planweave-ai/collaboration-protocol";

export const collaborationCommandErrorSchema = collaborationBoundaryErrorSchema
  .extend({
    message: z.string().min(1).max(512)
  })
  .strict();
export type CollaborationCommandError = z.infer<typeof collaborationCommandErrorSchema>;

export type CollaborationCommandResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CollaborationCommandError };

export function collaborationCommandResultSchema<T>(valueSchema: z.ZodType<T>) {
  return z.discriminatedUnion("ok", [
    z
      .object({
        ok: z.literal(true),
        value: valueSchema
      })
      .strict(),
    z
      .object({
        ok: z.literal(false),
        error: collaborationCommandErrorSchema
      })
      .strict()
  ]);
}

export class CollaborationBoundaryError extends Error {
  readonly kind: CollaborationBoundaryErrorKind;
  readonly code: string;
  readonly httpStatus?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(input: CollaborationCommandError) {
    super(input.message);
    this.name = "CollaborationBoundaryError";
    this.kind = input.kind;
    this.code = input.code;
    this.httpStatus = input.httpStatus;
    this.retryable = input.retryable;
    this.retryAfterMs = input.retryAfterMs;
  }
}

export function unwrapCollaborationCommandResult<T>(input: unknown, valueSchema: z.ZodType<T>): T {
  const parsed = collaborationCommandResultSchema(valueSchema).parse(input);
  if (parsed.ok) return parsed.value;
  throw new CollaborationBoundaryError(parsed.error);
}
