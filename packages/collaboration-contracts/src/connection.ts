import { z } from "zod";
import {
  COLLABORATION_JSON_BODY_MAX_BYTES,
  COLLABORATION_REQUEST_TIMEOUT_MS,
  HUMAN_OBSERVER_MAX_PAYLOAD_BYTES,
  WORKSPACE_PICKER_MAX_ITEMS_PER_PAGE
} from "./limits.js";
import {
  humanProjectIdSchema,
  opaqueIdentifierSchema,
  workspaceIdSchema,
  workspaceIdentitySchemaVersionSchema,
  workspaceNameSchema,
  workspaceRoleSchema,
  workspaceSetupSchemaVersionSchema,
  timestampSchema
} from "./primitives.js";

/**
 * HTTP(S) origin only: protocol + host [+ port], path must be `/`.
 * Arbitrary absolute URLs with paths, query strings, or non-http schemes are rejected.
 */
export function isCollaborationServerOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}

/** Literal private-network hosts accepted for explicitly enabled LAN HTTP. */
export function isPrivateNetworkHostname(hostname: string): boolean {
  if (isLoopbackHostname(hostname)) return true;
  const octets = hostname.split(".").map((part) => Number(part));
  if (
    octets.length === 4 &&
    octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  ) {
    const [first, second] = octets as [number, number, number, number];
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }
  return false;
}

/** Shared origin validator for Desktop profiles and setup handoff envelopes. */
export const collaborationServerOriginSchema = z
  .string()
  .url()
  .refine(isCollaborationServerOrigin, "serverBaseUrl must be an http(s) origin without a path");

export function refineCollaborationTransportPolicy(
  value: { serverBaseUrl: string; allowInsecureTransport: boolean },
  ctx: z.RefinementCtx
): void {
  const url = new URL(value.serverBaseUrl);
  if (url.protocol !== "https:" && !value.allowInsecureTransport) {
    ctx.addIssue({
      code: "custom",
      message: "HTTPS is required unless allowInsecureTransport is true",
      path: ["serverBaseUrl"]
    });
  }
  if (value.allowInsecureTransport && url.protocol === "http:") {
    if (!isPrivateNetworkHostname(url.hostname)) {
      ctx.addIssue({
        code: "custom",
        message: "Insecure HTTP is only allowed for loopback or private-network hosts",
        path: ["serverBaseUrl"]
      });
    }
  }
}

/**
 * Validated Desktop connection profile for a logical project/server pair.
 * Does not store credentials — credential is injected via a separate port.
 */
export const collaborationConnectionProfileSchema = z
  .object({
    profileId: opaqueIdentifierSchema,
    displayName: z.string().trim().min(1).max(128),
    /** Base URL origin only (no path). HTTPS required unless allowInsecureTransport. */
    serverBaseUrl: collaborationServerOriginSchema,
    projectId: humanProjectIdSchema,
    allowInsecureTransport: z.boolean().default(false)
  })
  .strict()
  .superRefine(refineCollaborationTransportPolicy);
export type CollaborationConnectionProfile = z.infer<typeof collaborationConnectionProfileSchema>;

/**
 * Workspace-first connection profile. Unlike the legacy project profile above,
 * this profile cannot be created without an opaque Workspace authority. It never
 * carries a device/operator/Host secret; callers inject credentials through a
 * separate secure transport port.
 */
export const workspaceConnectionProfileSchema = z
  .object({
    schemaVersion: workspaceIdentitySchemaVersionSchema,
    profileId: opaqueIdentifierSchema,
    displayName: workspaceNameSchema,
    serverBaseUrl: collaborationServerOriginSchema,
    workspaceId: workspaceIdSchema,
    allowInsecureTransport: z.boolean()
  })
  .strict()
  .superRefine(refineCollaborationTransportPolicy);
export type WorkspaceConnectionProfile = z.infer<typeof workspaceConnectionProfileSchema>;

export function parseWorkspaceConnectionProfile(input: unknown): WorkspaceConnectionProfile {
  return workspaceConnectionProfileSchema.parse(input);
}

/**
 * Redacted Workspace picker row for Desktop renderer. No credentials, digests,
 * projectRoot, commands, or arbitrary URLs.
 */
export const workspacePickerItemSchema = z
  .object({
    schemaVersion: workspaceSetupSchemaVersionSchema,
    workspaceId: workspaceIdSchema,
    displayName: workspaceNameSchema,
    role: workspaceRoleSchema.nullable(),
    archivedAt: timestampSchema.nullable(),
    membershipActive: z.boolean()
  })
  .strict();
export type WorkspacePickerItem = z.infer<typeof workspacePickerItemSchema>;

export const workspacePickerPageSchema = z
  .object({
    schemaVersion: workspaceSetupSchemaVersionSchema,
    items: z.array(workspacePickerItemSchema).max(WORKSPACE_PICKER_MAX_ITEMS_PER_PAGE),
    nextCursor: z.number().int().nonnegative().nullable()
  })
  .strict();
export type WorkspacePickerPage = z.infer<typeof workspacePickerPageSchema>;

/**
 * Desktop "single Server/Workspace connection" status. Exactly one active remote
 * connection is modeled; local-only projects remain disconnected until the user
 * explicitly connects. Secrets never appear here.
 */
export const activeWorkspaceConnectionStatusSchema = z.enum([
  "local_only",
  "connecting",
  "connected",
  "reconnecting",
  "error",
  "disconnected"
]);
export type ActiveWorkspaceConnectionStatus = z.infer<
  typeof activeWorkspaceConnectionStatusSchema
>;

export const activeWorkspaceConnectionErrorSchema = z
  .object({
    code: z.string().trim().min(1).max(128),
    message: z.string().trim().min(1).max(512).optional(),
    retryable: z.boolean()
  })
  .strict();
export type ActiveWorkspaceConnectionError = z.infer<typeof activeWorkspaceConnectionErrorSchema>;

export const activeWorkspaceConnectionViewSchema = z
  .object({
    schemaVersion: workspaceSetupSchemaVersionSchema,
    status: activeWorkspaceConnectionStatusSchema,
    profile: workspaceConnectionProfileSchema.nullable(),
    workspaceId: workspaceIdSchema.nullable(),
    workspaceDisplayName: workspaceNameSchema.nullable(),
    connectedAt: timestampSchema.nullable(),
    error: activeWorkspaceConnectionErrorSchema.nullable()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "local_only") {
      if (value.profile !== null || value.workspaceId !== null) {
        ctx.addIssue({
          code: "custom",
          message: "local_only_connection_must_not_bind_remote_profile"
        });
      }
      return;
    }
    if (value.status === "connected" || value.status === "reconnecting") {
      if (value.profile === null || value.workspaceId === null) {
        ctx.addIssue({
          code: "custom",
          message: "active_connection_requires_profile_and_workspace"
        });
      } else if (value.profile.workspaceId !== value.workspaceId) {
        ctx.addIssue({
          code: "custom",
          message: "connection_workspace_mismatch"
        });
      }
    }
    if (value.status === "error" && value.error === null) {
      ctx.addIssue({ code: "custom", message: "error_connection_requires_error" });
    }
  });
export type ActiveWorkspaceConnectionView = z.infer<typeof activeWorkspaceConnectionViewSchema>;

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
