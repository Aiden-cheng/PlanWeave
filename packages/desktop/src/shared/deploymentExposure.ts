import { z } from "zod";
import {
  deploymentEndpointSchema,
  deploymentTopologySchema
} from "@planweave-ai/collaboration-protocol/deployment";

export const desktopServerExposureModeSchema = z.enum([
  "local_only",
  "tailscale_private",
  "custom_https",
  "lan_http"
]);
export type DesktopServerExposureMode = z.infer<typeof desktopServerExposureModeSchema>;

export const desktopServerExposureErrorCodeSchema = z.union([
  z.enum([
    "TAILSCALE_NOT_INSTALLED",
    "TAILSCALE_VERSION_UNSUPPORTED",
    "TAILSCALE_DAEMON_NOT_RUNNING",
    "TAILSCALE_LOGIN_REQUIRED",
    "TAILSCALE_MACHINE_AUTH_REQUIRED",
    "TAILSCALE_MAGIC_DNS_UNAVAILABLE",
    "TAILSCALE_HTTPS_UNAVAILABLE",
    "TAILSCALE_ORIGIN_MISMATCH",
    "TAILSCALE_SERVE_CONFLICT",
    "TAILSCALE_SERVE_UNOWNED",
    "TAILSCALE_LEASE_DRIFT",
    "TAILSCALE_LEASE_PERSISTENCE_FAILED",
    "TAILSCALE_COMMAND_FAILED",
    "TAILSCALE_JSON_INVALID",
    "TAILSCALE_EXTERNAL_PROBE_FAILED",
    "SERVER_START_FAILED",
    "SERVER_STOP_FAILED",
    "SERVER_SELECTION_REQUIRED",
    "CUSTOM_HTTPS_CONFIGURATION_REQUIRED"
  ])
]);
export type DesktopServerExposureErrorCode = z.infer<typeof desktopServerExposureErrorCodeSchema>;

export const desktopServerExposureViewSchema = z
  .object({
    mode: desktopServerExposureModeSchema,
    topology: deploymentTopologySchema.nullable(),
    lifecycle: z.enum(["stopped", "preparing", "ready", "error"]),
    advertisedOrigin: z.string().url().nullable(),
    errorCode: desktopServerExposureErrorCodeSchema.nullable(),
    canActivate: z.boolean(),
    canInvite: z.boolean()
  })
  .strict();
export type DesktopServerExposureView = z.infer<typeof desktopServerExposureViewSchema>;

export const desktopServerExposureModeInputSchema = z
  .object({ mode: desktopServerExposureModeSchema })
  .strict();
export type DesktopServerExposureModeInput = z.infer<typeof desktopServerExposureModeInputSchema>;

export const desktopInvitationEndpointSchema = deploymentEndpointSchema;
