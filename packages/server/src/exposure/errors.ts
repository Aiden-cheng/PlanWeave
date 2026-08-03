import { z } from "zod";

export const tailscaleExposureErrorCodeSchema = z.enum([
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
  "TAILSCALE_EXTERNAL_PROBE_FAILED"
]);

export type TailscaleExposureErrorCode = z.infer<typeof tailscaleExposureErrorCodeSchema>;

export const TAILSCALE_EXPOSURE_ERROR_MESSAGES: Readonly<
  Record<TailscaleExposureErrorCode, string>
> = {
  TAILSCALE_NOT_INSTALLED: "Tailscale CLI is not installed.",
  TAILSCALE_VERSION_UNSUPPORTED: "The installed Tailscale CLI version is not supported.",
  TAILSCALE_DAEMON_NOT_RUNNING: "The Tailscale daemon is not running.",
  TAILSCALE_LOGIN_REQUIRED: "Tailscale login is required.",
  TAILSCALE_MACHINE_AUTH_REQUIRED: "This Tailscale device requires machine authorization.",
  TAILSCALE_MAGIC_DNS_UNAVAILABLE: "Tailscale MagicDNS is not available for this device.",
  TAILSCALE_HTTPS_UNAVAILABLE: "Tailscale HTTPS certificates are not available for this device.",
  TAILSCALE_ORIGIN_MISMATCH: "The configured Tailscale origin does not match this device.",
  TAILSCALE_SERVE_CONFLICT: "The Tailscale Serve root route is already configured differently.",
  TAILSCALE_SERVE_UNOWNED: "The matching Tailscale Serve route is not owned by PlanWeave.",
  TAILSCALE_LEASE_DRIFT: "The owned Tailscale Serve route has changed and was not modified.",
  TAILSCALE_LEASE_PERSISTENCE_FAILED: "The Tailscale Serve ownership lease could not be saved.",
  TAILSCALE_COMMAND_FAILED: "A Tailscale CLI command failed.",
  TAILSCALE_JSON_INVALID: "Tailscale returned unsupported structured output.",
  TAILSCALE_EXTERNAL_PROBE_FAILED: "The external Tailscale readiness probe failed."
};

export class TailscaleExposureError extends Error {
  constructor(
    readonly code: TailscaleExposureErrorCode,
    options?: { cause?: unknown }
  ) {
    super(TAILSCALE_EXPOSURE_ERROR_MESSAGES[code], options);
    this.name = "TailscaleExposureError";
  }
}

export function tailscaleExposureFailure(
  code: TailscaleExposureErrorCode,
  cause?: unknown
): TailscaleExposureError {
  return new TailscaleExposureError(code, cause === undefined ? undefined : { cause });
}
