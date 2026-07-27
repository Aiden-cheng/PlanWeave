import { randomUUID } from "node:crypto";
import {
  canvasCommandIntentSchema,
  canvasCommandOperationIdSchema,
  opaqueIdentifierSchema,
  type CanvasCommandIntent,
  type CanvasCommandOutcome,
  type CanvasJournalEntry,
  type CanvasReconnectResponse
} from "@planweave-ai/collaboration-contracts";
import { z } from "zod";
import type { CollaborationClient } from "./CollaborationClient.js";
import { CollaborationClientError } from "./collaborationErrors.js";
import type { CanvasCommandSessionSnapshot } from "./canvasCommandSession.js";

export const collaborationCanvasCommandSubmitInputSchema = z
  .object({
    canvasId: opaqueIdentifierSchema,
    intent: canvasCommandIntentSchema,
    operationId: canvasCommandOperationIdSchema.optional(),
    expectedRevision: z.number().int().nonnegative().optional()
  })
  .strict();
export type CollaborationCanvasCommandSubmitInput = z.infer<
  typeof collaborationCanvasCommandSubmitInputSchema
>;

export const collaborationCanvasReconnectInputSchema = z
  .object({
    canvasId: opaqueIdentifierSchema,
    afterRevision: z.number().int().nonnegative().optional(),
    afterContentDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
  })
  .strict();
export type CollaborationCanvasReconnectInput = z.infer<
  typeof collaborationCanvasReconnectInputSchema
>;

export const collaborationCanvasSessionInputSchema = z
  .object({
    canvasId: opaqueIdentifierSchema
  })
  .strict();

/** Public result of a canvas command submit (no secrets). */
export type CollaborationCanvasCommandSubmitResult = {
  outcome: CanvasCommandOutcome;
  session: CanvasCommandSessionSnapshot | null;
};

/** Public result of canvas reconnect (no secrets). */
export type CollaborationCanvasReconnectResult = {
  response: CanvasReconnectResponse;
  entriesToApply: CanvasJournalEntry[];
  snapshotRequired: boolean;
  session: CanvasCommandSessionSnapshot | null;
};

export type CollaborationCanvasCommandSessionView = CanvasCommandSessionSnapshot | null;

function requireClient(client: CollaborationClient | null): CollaborationClient {
  if (!client) {
    throw new CollaborationClientError({
      kind: "aborted",
      code: "collaboration_session_not_connected",
      message: "Collaboration session is not connected."
    });
  }
  return client;
}

/**
 * Service-facing seam for durable canvas commands.
 * Keeps command/read-model boundaries out of the monolithic service body.
 */
export class CollaborationCanvasCommandFacade {
  constructor(private readonly resolveClient: () => CollaborationClient | null) {}

  async submit(input: unknown): Promise<CollaborationCanvasCommandSubmitResult> {
    const parsed = collaborationCanvasCommandSubmitInputSchema.parse(input);
    const client = requireClient(this.resolveClient());
    const operationId =
      parsed.operationId ??
      canvasCommandOperationIdSchema.parse(`op-${randomUUID().replace(/-/g, "").slice(0, 24)}`);
    const outcome = await client.submitCanvasCommand({
      canvasId: parsed.canvasId,
      operationId,
      intent: parsed.intent as CanvasCommandIntent,
      expectedRevision: parsed.expectedRevision
    });
    return {
      outcome,
      session: client.canvasCommandSession()
    };
  }

  async reconnect(input: unknown): Promise<CollaborationCanvasReconnectResult> {
    const parsed = collaborationCanvasReconnectInputSchema.parse(input);
    const client = requireClient(this.resolveClient());
    const result = await client.reconnectCanvasCommands({
      canvasId: parsed.canvasId,
      afterRevision: parsed.afterRevision,
      afterContentDigest: parsed.afterContentDigest
    });
    return {
      response: result.response,
      entriesToApply: result.entriesToApply,
      snapshotRequired: result.snapshotRequired,
      session: result.session
    };
  }

  bind(input: unknown): CollaborationCanvasCommandSessionView {
    const parsed = collaborationCanvasSessionInputSchema.parse(input);
    const client = requireClient(this.resolveClient());
    client.bindCanvasCommandSession(parsed.canvasId);
    return client.canvasCommandSession();
  }

  session(): CollaborationCanvasCommandSessionView {
    const client = this.resolveClient();
    return client?.canvasCommandSession() ?? null;
  }
}
