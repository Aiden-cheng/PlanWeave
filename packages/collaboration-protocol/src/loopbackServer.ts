import { z } from "zod";
import {
  collaborationServerOriginSchema,
  isLoopbackHostname,
  workspaceConnectionProfileSchema
} from "./connection.js";
import { canvasScopeRefSchema, timestampSchema, workspaceIdSchema } from "./primitives.js";

function requireLoopbackDevelopmentOrigin(
  value: { serverBaseUrl: string; allowInsecureTransport: boolean },
  ctx: z.RefinementCtx
): void {
  const url = new URL(value.serverBaseUrl);
  const trustedReverseProxyOrigin =
    url.protocol === "https:" && value.allowInsecureTransport === false;
  if (!isLoopbackHostname(url.hostname) && !trustedReverseProxyOrigin) {
    ctx.addIssue({
      code: "custom",
      message: "local_server_requires_loopback_or_trusted_https_advertised_origin",
      path: ["serverBaseUrl"]
    });
  }
  if (url.protocol === "http:" && !value.allowInsecureTransport) {
    ctx.addIssue({
      code: "custom",
      message: "loopback_server_requires_literal_loopback_http_opt_in",
      path: ["serverBaseUrl"]
    });
  }
}

/** A local Server profile with a loopback or trusted reverse-proxy Origin. */
export const loopbackServerProfileSchema = z
  .object({
    profileId: z.string().trim().min(1).max(128),
    displayName: z.string().trim().min(1).max(128),
    serverBaseUrl: collaborationServerOriginSchema,
    allowInsecureTransport: z.boolean()
  })
  .strict()
  .superRefine(requireLoopbackDevelopmentOrigin);
export type LoopbackServerProfile = z.infer<typeof loopbackServerProfileSchema>;

export const loopbackServerLifecycleStateSchema = z.enum([
  "stopped",
  "starting",
  "running",
  "stopping",
  "error"
]);
export type LoopbackServerLifecycleState = z.infer<typeof loopbackServerLifecycleStateSchema>;

export const loopbackServerStatusSchema = z
  .object({
    profile: loopbackServerProfileSchema.nullable(),
    state: loopbackServerLifecycleStateSchema,
    startedAt: timestampSchema.nullable(),
    reason: z.enum(["start_failed", "stop_failed", "unavailable"]).nullable()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.state === "running" || value.state === "starting" || value.state === "stopping") &&
      value.profile === null
    ) {
      ctx.addIssue({ code: "custom", message: "active_loopback_server_requires_profile" });
    }
    if (value.state === "error" && value.reason === null) {
      ctx.addIssue({ code: "custom", message: "loopback_server_error_requires_reason" });
    }
  });
export type LoopbackServerStatus = z.infer<typeof loopbackServerStatusSchema>;

export const startLoopbackServerRequestSchema = z
  .object({ action: z.literal("start"), profile: loopbackServerProfileSchema })
  .strict();
export type StartLoopbackServerRequest = z.infer<typeof startLoopbackServerRequestSchema>;

export const stopLoopbackServerRequestSchema = z
  .object({ action: z.literal("stop"), profileId: z.string().trim().min(1).max(128) })
  .strict();
export type StopLoopbackServerRequest = z.infer<typeof stopLoopbackServerRequestSchema>;

export const loopbackServerLifecycleRequestSchema = z.discriminatedUnion("action", [
  startLoopbackServerRequestSchema,
  stopLoopbackServerRequestSchema
]);
export type LoopbackServerLifecycleRequest = z.infer<typeof loopbackServerLifecycleRequestSchema>;

/** A renderer-safe exact scope for a project currently trusted by a running Server. */
export const loopbackTrustedProjectScopeSchema = canvasScopeRefSchema;
export type LoopbackTrustedProjectScope = z.infer<typeof loopbackTrustedProjectScopeSchema>;

export const loopbackTrustedProjectListRequestSchema = z
  .object({ profileId: z.string().trim().min(1).max(128) })
  .strict();
export type LoopbackTrustedProjectListRequest = z.infer<
  typeof loopbackTrustedProjectListRequestSchema
>;

/** Current project registration contains only opaque IDs, never a local filesystem authority. */
export const loopbackProjectRegistrationRequestSchema = loopbackTrustedProjectScopeSchema
  .extend({ profileId: z.string().trim().min(1).max(128) })
  .strict();
export type LoopbackProjectRegistrationRequest = z.infer<
  typeof loopbackProjectRegistrationRequestSchema
>;

export const loopbackProjectRegistrationViewSchema = loopbackProjectRegistrationRequestSchema
  .extend({ registeredAt: timestampSchema })
  .strict();
export type LoopbackProjectRegistrationView = z.infer<typeof loopbackProjectRegistrationViewSchema>;

/** Setup consumes the existing redacted workspace connection profile; owner credentials stay outside renderer DTOs. */
export const loopbackOwnerConnectionRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    profile: workspaceConnectionProfileSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.workspaceId !== value.profile.workspaceId) {
      ctx.addIssue({ code: "custom", message: "owner_connection_workspace_mismatch" });
    }
    requireLoopbackDevelopmentOrigin(value.profile, ctx);
  });
export type LoopbackOwnerConnectionRequest = z.infer<typeof loopbackOwnerConnectionRequestSchema>;

export const loopbackOwnerConnectionViewSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    connected: z.boolean(),
    profile: workspaceConnectionProfileSchema.nullable(),
    reason: z.enum(["setup_required", "connection_failed", "revoked"]).nullable()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.connected && value.profile === null) {
      ctx.addIssue({ code: "custom", message: "connected_owner_requires_profile" });
    }
    if (value.connected && value.reason !== null) {
      ctx.addIssue({ code: "custom", message: "connected_owner_must_not_have_reason" });
    }
    if (value.profile !== null) requireLoopbackDevelopmentOrigin(value.profile, ctx);
  });
export type LoopbackOwnerConnectionView = z.infer<typeof loopbackOwnerConnectionViewSchema>;
