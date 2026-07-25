import { z } from "zod";
import {
  COLLABORATION_JSON_BODY_MAX_BYTES,
  COLLABORATION_REQUEST_TIMEOUT_MS,
  HUMAN_OBSERVER_MAX_PAYLOAD_BYTES
} from "./limits.js";
import { humanProjectIdSchema, opaqueIdentifierSchema } from "./primitives.js";

/**
 * Validated Desktop connection profile for a logical project/server pair.
 * Does not store credentials — credential is injected via a separate port.
 */
export const collaborationConnectionProfileSchema = z
  .object({
    profileId: opaqueIdentifierSchema,
    displayName: z.string().trim().min(1).max(128),
    /** Base URL origin only (no path). HTTPS required unless allowInsecureTransport. */
    serverBaseUrl: z
      .string()
      .url()
      .refine((value) => {
        try {
          const url = new URL(value);
          return (url.protocol === "https:" || url.protocol === "http:") && url.pathname === "/";
        } catch {
          return false;
        }
      }, "serverBaseUrl must be an http(s) origin without a path"),
    projectId: humanProjectIdSchema,
    allowInsecureTransport: z.boolean().default(false)
  })
  .strict()
  .superRefine((value, ctx) => {
    const url = new URL(value.serverBaseUrl);
    if (url.protocol !== "https:" && !value.allowInsecureTransport) {
      ctx.addIssue({
        code: "custom",
        message: "HTTPS is required unless allowInsecureTransport is true",
        path: ["serverBaseUrl"]
      });
    }
    if (value.allowInsecureTransport && url.protocol === "http:") {
      const host = url.hostname;
      const loopback =
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        host.endsWith(".localhost");
      if (!loopback) {
        ctx.addIssue({
          code: "custom",
          message: "Insecure HTTP is only allowed for loopback hosts",
          path: ["serverBaseUrl"]
        });
      }
    }
  });
export type CollaborationConnectionProfile = z.infer<typeof collaborationConnectionProfileSchema>;

export const collaborationClientLimitsSchema = z
  .object({
    requestTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(300_000)
      .default(COLLABORATION_REQUEST_TIMEOUT_MS),
    jsonBodyMaxBytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1_024 * 1_024)
      .default(COLLABORATION_JSON_BODY_MAX_BYTES),
    observerMaxPayloadBytes: z
      .number()
      .int()
      .positive()
      .max(4 * 1_024 * 1_024)
      .default(HUMAN_OBSERVER_MAX_PAYLOAD_BYTES),
    reconnectInitialDelayMs: z.number().int().positive().max(60_000).default(250),
    reconnectMaxDelayMs: z.number().int().positive().max(300_000).default(30_000)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.reconnectInitialDelayMs > value.reconnectMaxDelayMs) {
      ctx.addIssue({
        code: "custom",
        message: "reconnectInitialDelayMs must be <= reconnectMaxDelayMs",
        path: ["reconnectInitialDelayMs"]
      });
    }
  });
export type CollaborationClientLimits = z.infer<typeof collaborationClientLimitsSchema>;

export function parseCollaborationConnectionProfile(
  input: unknown
): CollaborationConnectionProfile {
  return collaborationConnectionProfileSchema.parse(input);
}

export function parseCollaborationClientLimits(
  input: Partial<CollaborationClientLimits> | undefined = {}
): CollaborationClientLimits {
  return collaborationClientLimitsSchema.parse(input);
}
