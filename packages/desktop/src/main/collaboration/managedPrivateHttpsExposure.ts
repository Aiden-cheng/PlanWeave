import {
  ServerExposureManager,
  TailscaleCliAdapter,
  TailscaleExposureError,
  type ExposureLeaseStorePort,
  type ExposureOwnership,
  type ServerExposureLifecyclePort,
  type TailscaleControlPort
} from "@planweave-ai/server";
import type { DesktopServerExposureErrorCode } from "../../shared/deploymentExposure.js";

export type ManagedPrivateHttpsProvider = Readonly<{
  id: string;
  displayName: string;
}>;

type ManagedPrivateHttpsErrorCode = Extract<
  DesktopServerExposureErrorCode,
  | "PRIVATE_HTTPS_PROVIDER_NOT_INSTALLED"
  | "PRIVATE_HTTPS_PROVIDER_AUTH_REQUIRED"
  | "PRIVATE_HTTPS_DNS_UNAVAILABLE"
  | "PRIVATE_HTTPS_CERTIFICATE_UNAVAILABLE"
  | "PRIVATE_HTTPS_ROUTE_CONFLICT"
  | "PRIVATE_HTTPS_EXTERNAL_PROBE_FAILED"
  | "PRIVATE_HTTPS_PROVIDER_UNAVAILABLE"
>;

export class ManagedPrivateHttpsExposureError extends Error {
  constructor(
    readonly code: ManagedPrivateHttpsErrorCode,
    options?: ErrorOptions
  ) {
    super(code, options);
    this.name = "ManagedPrivateHttpsExposureError";
  }
}

export interface ManagedPrivateHttpsExposurePort {
  readonly provider: ManagedPrivateHttpsProvider;
  resolveAdvertisedOrigin(): Promise<string>;
  createLifecycle(leases: ExposureLeaseStorePort): ServerExposureLifecyclePort;
}

function mapTailscaleError(error: unknown): ManagedPrivateHttpsExposureError {
  if (!(error instanceof TailscaleExposureError)) {
    return new ManagedPrivateHttpsExposureError("PRIVATE_HTTPS_PROVIDER_UNAVAILABLE", {
      cause: error
    });
  }
  const code: ManagedPrivateHttpsErrorCode =
    error.code === "TAILSCALE_NOT_INSTALLED"
      ? "PRIVATE_HTTPS_PROVIDER_NOT_INSTALLED"
      : error.code === "TAILSCALE_LOGIN_REQUIRED" ||
          error.code === "TAILSCALE_MACHINE_AUTH_REQUIRED"
        ? "PRIVATE_HTTPS_PROVIDER_AUTH_REQUIRED"
        : error.code === "TAILSCALE_MAGIC_DNS_UNAVAILABLE"
          ? "PRIVATE_HTTPS_DNS_UNAVAILABLE"
          : error.code === "TAILSCALE_HTTPS_UNAVAILABLE"
            ? "PRIVATE_HTTPS_CERTIFICATE_UNAVAILABLE"
            : error.code === "TAILSCALE_SERVE_CONFLICT" ||
                error.code === "TAILSCALE_SERVE_UNOWNED" ||
                error.code === "TAILSCALE_LEASE_DRIFT"
              ? "PRIVATE_HTTPS_ROUTE_CONFLICT"
              : error.code === "TAILSCALE_EXTERNAL_PROBE_FAILED"
                ? "PRIVATE_HTTPS_EXTERNAL_PROBE_FAILED"
                : "PRIVATE_HTTPS_PROVIDER_UNAVAILABLE";
  return new ManagedPrivateHttpsExposureError(code, { cause: error });
}

function mapLifecycleErrors(delegate: ServerExposureLifecyclePort): ServerExposureLifecyclePort {
  return {
    async inspect(config) {
      try {
        return await delegate.inspect(config);
      } catch (error) {
        throw mapTailscaleError(error);
      }
    },
    async activate(config) {
      try {
        return await delegate.activate(config);
      } catch (error) {
        throw mapTailscaleError(error);
      }
    },
    async release(ownership: ExposureOwnership) {
      try {
        await delegate.release(ownership);
      } catch (error) {
        throw mapTailscaleError(error);
      }
    }
  };
}

export class TailscaleManagedPrivateHttpsAdapter implements ManagedPrivateHttpsExposurePort {
  readonly provider = Object.freeze({ id: "tailscale", displayName: "Tailscale" });

  constructor(private readonly control: TailscaleControlPort = new TailscaleCliAdapter()) {}

  async resolveAdvertisedOrigin(): Promise<string> {
    try {
      const node = await this.control.inspectNode();
      return `https://${node.dnsName}/`;
    } catch (error) {
      throw mapTailscaleError(error);
    }
  }

  createLifecycle(leases: ExposureLeaseStorePort): ServerExposureLifecyclePort {
    return mapLifecycleErrors(
      new ServerExposureManager({
        tailscale: this.control,
        leases
      })
    );
  }
}
