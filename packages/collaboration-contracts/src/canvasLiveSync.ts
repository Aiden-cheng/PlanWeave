import { z } from "zod";
import { CANVAS_LIVE_SYNC_PROTOCOL_VERSION } from "./limits.js";
import {
  canvasContentDigestSchema,
  canvasJournalEntrySchema,
  canvasRevisionSchema
} from "./canvasCommands.js";
import { humanProjectIdSchema, opaqueIdentifierSchema, timestampSchema } from "./primitives.js";

/**
 * Read-only Server-to-Desktop Canvas journal stream.
 * Clients submit mutations through the authenticated HTTP command endpoint and use HTTP reconnect
 * for catch-up; this channel only pushes accepted, durable journal entries after commit.
 */
export const canvasLiveSyncProtocolVersionSchema = z.literal(CANVAS_LIVE_SYNC_PROTOCOL_VERSION);
export type CanvasLiveSyncProtocolVersion = z.infer<typeof canvasLiveSyncProtocolVersionSchema>;

const canvasLiveSyncScopeShape = {
  protocolVersion: canvasLiveSyncProtocolVersionSchema,
  projectId: humanProjectIdSchema,
  canvasId: opaqueIdentifierSchema
} as const;

export const canvasLiveSyncHelloSchema = z
  .object({
    type: z.literal("canvas.live.hello"),
    ...canvasLiveSyncScopeShape,
    /** Last revision materialized locally; 0 is the initial empty journal head. */
    lastRevision: canvasRevisionSchema
  })
  .strict();
export type CanvasLiveSyncHello = z.infer<typeof canvasLiveSyncHelloSchema>;

export const canvasLiveSyncWelcomeSchema = z
  .object({
    type: z.literal("canvas.live.welcome"),
    ...canvasLiveSyncScopeShape,
    serverTime: timestampSchema,
    headRevision: canvasRevisionSchema,
    headContentDigest: canvasContentDigestSchema
  })
  .strict();
export type CanvasLiveSyncWelcome = z.infer<typeof canvasLiveSyncWelcomeSchema>;

/** Complete, validated journal entry emitted only after the authority transaction commits. */
export const canvasLiveSyncAcceptedEntrySchema = z
  .object({
    type: z.literal("canvas.live.accepted_entry"),
    protocolVersion: canvasLiveSyncProtocolVersionSchema,
    entry: canvasJournalEntrySchema
  })
  .strict();
export type CanvasLiveSyncAcceptedEntry = z.infer<typeof canvasLiveSyncAcceptedEntrySchema>;

/** No WebSocket history replay: clients must use the existing authenticated HTTP reconnect route. */
export const canvasLiveSyncCatchupRequiredSchema = z
  .object({
    type: z.literal("canvas.live.catchup_required"),
    ...canvasLiveSyncScopeShape,
    reason: z.enum(["revision_behind", "revision_ahead", "head_changed"]),
    recovery: z.literal("http_reconnect"),
    headRevision: canvasRevisionSchema,
    headContentDigest: canvasContentDigestSchema
  })
  .strict();
export type CanvasLiveSyncCatchupRequired = z.infer<typeof canvasLiveSyncCatchupRequiredSchema>;

export const canvasLiveSyncErrorCodeSchema = z.enum([
  "unauthorized",
  "forbidden",
  "unknown_canvas",
  "cross_scope",
  "unsupported_version",
  "invalid_message",
  "frame_too_large",
  "server_error"
]);
export type CanvasLiveSyncErrorCode = z.infer<typeof canvasLiveSyncErrorCodeSchema>;

export const canvasLiveSyncErrorSchema = z
  .object({
    type: z.literal("canvas.live.error"),
    ...canvasLiveSyncScopeShape,
    code: canvasLiveSyncErrorCodeSchema
  })
  .strict();
export type CanvasLiveSyncError = z.infer<typeof canvasLiveSyncErrorSchema>;

export const canvasLiveSyncAuthExpiredSchema = z
  .object({
    type: z.literal("canvas.live.auth_expired"),
    ...canvasLiveSyncScopeShape,
    code: z.enum(["unauthorized", "forbidden", "unknown_canvas", "cross_scope"])
  })
  .strict();
export type CanvasLiveSyncAuthExpired = z.infer<typeof canvasLiveSyncAuthExpiredSchema>;

export const canvasLiveSyncPingSchema = z
  .object({
    type: z.literal("canvas.live.ping"),
    protocolVersion: canvasLiveSyncProtocolVersionSchema
  })
  .strict();
export type CanvasLiveSyncPing = z.infer<typeof canvasLiveSyncPingSchema>;

export const canvasLiveSyncPongSchema = z
  .object({
    type: z.literal("canvas.live.pong"),
    protocolVersion: canvasLiveSyncProtocolVersionSchema,
    serverTime: timestampSchema
  })
  .strict();
export type CanvasLiveSyncPong = z.infer<typeof canvasLiveSyncPongSchema>;

export const canvasLiveSyncClientMessageSchema = z.discriminatedUnion("type", [
  canvasLiveSyncHelloSchema,
  canvasLiveSyncPingSchema
]);
export type CanvasLiveSyncClientMessage = z.infer<typeof canvasLiveSyncClientMessageSchema>;

export const canvasLiveSyncServerMessageSchema = z.discriminatedUnion("type", [
  canvasLiveSyncWelcomeSchema,
  canvasLiveSyncAcceptedEntrySchema,
  canvasLiveSyncCatchupRequiredSchema,
  canvasLiveSyncErrorSchema,
  canvasLiveSyncAuthExpiredSchema,
  canvasLiveSyncPongSchema
]);
export type CanvasLiveSyncServerMessage = z.infer<typeof canvasLiveSyncServerMessageSchema>;

export function parseCanvasLiveSyncClientMessage(input: unknown): CanvasLiveSyncClientMessage {
  return canvasLiveSyncClientMessageSchema.parse(input);
}

export function parseCanvasLiveSyncServerMessage(input: unknown): CanvasLiveSyncServerMessage {
  return canvasLiveSyncServerMessageSchema.parse(input);
}
