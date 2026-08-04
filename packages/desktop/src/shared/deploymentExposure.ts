import { z } from "zod";
import {
  deploymentEndpointSchema,
  deploymentTopologySchema
} from "@planweave-ai/collaboration-protocol/deployment";

export const desktopServerExposureModeSchema = z.enum([
  "local_only",
  "private_https",
  "custom_https",
  "lan_http"
]);
export type DesktopServerExposureMode = z.infer<typeof desktopServerExposureModeSchema>;

export const desktopServerExposureErrorCodeSchema = z.union([
  z.enum([
    "PRIVATE_HTTPS_PROVIDER_NOT_INSTALLED",
    "PRIVATE_HTTPS_PROVIDER_AUTH_REQUIRED",
    "PRIVATE_HTTPS_DNS_UNAVAILABLE",
    "PRIVATE_HTTPS_CERTIFICATE_UNAVAILABLE",
    "PRIVATE_HTTPS_ROUTE_CONFLICT",
    "PRIVATE_HTTPS_EXTERNAL_PROBE_FAILED",
    "PRIVATE_HTTPS_PROVIDER_UNAVAILABLE",
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
    provider: z
      .object({ id: z.string().min(1).max(64), displayName: z.string().min(1).max(128) })
      .strict()
      .nullable(),
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
