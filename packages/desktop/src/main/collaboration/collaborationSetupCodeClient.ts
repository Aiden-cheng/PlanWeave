import {
  collaborationClientLimitsSchema,
  collaborationServerOriginSchema,
  isLoopbackHostname,
  setupCodeRedeemDeviceRequestSchema,
  setupCodeRedeemDeviceResponseSchema,
  type CollaborationClientLimits,
  type SetupCodeRedeemDeviceRequest,
  type SetupCodeRedeemDeviceResponse
} from "@planweave-ai/collaboration-contracts";
import {
  CollaborationClientError,
  collaborationErrorFromHttp,
  collaborationErrorFromUnknown
} from "./collaborationErrors.js";
import { redactCollaborationText } from "./redaction.js";

export type SetupCodeTransportOrigin = {
  serverBaseUrl: string;
  allowInsecureTransport: boolean;
};

export type CollaborationSetupCodeClientOptions = {
  origin: SetupCodeTransportOrigin;
  limits?: Partial<CollaborationClientLimits>;
  request?: typeof fetch;
};

function assertTransportPolicy(origin: SetupCodeTransportOrigin): {
  serverBaseUrl: string;
  allowInsecureTransport: boolean;
} {
  const serverBaseUrl = collaborationServerOriginSchema.parse(origin.serverBaseUrl);
  const allowInsecureTransport = origin.allowInsecureTransport === true;
  const url = new URL(serverBaseUrl);
  if (url.protocol !== "https:" && !allowInsecureTransport) {
    throw new CollaborationClientError({
      kind: "protocol",
      code: "collaboration_insecure_transport",
      message: "HTTPS is required unless allowInsecureTransport is true",
      retryable: false
    });
  }
  if (allowInsecureTransport && url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new CollaborationClientError({
      kind: "protocol",
      code: "collaboration_insecure_transport",
      message: "Insecure HTTP is only allowed for loopback hosts",
      retryable: false
    });
  }
  return { serverBaseUrl, allowInsecureTransport };
}

/**
 * Credential-free setup-code redeem transport.
 * Never logs tokens or setup codes; validates response contracts at the boundary.
 */
export class CollaborationSetupCodeClient {
  private readonly serverBaseUrl: string;
  private readonly limits: CollaborationClientLimits;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CollaborationSetupCodeClientOptions) {
    const origin = assertTransportPolicy(options.origin);
    this.serverBaseUrl = origin.serverBaseUrl;
    this.limits = collaborationClientLimitsSchema.parse(options.limits ?? {});
    this.fetchImpl = options.request ?? fetch;
  }

  async redeemDevice(
    input: SetupCodeRedeemDeviceRequest,
    signal?: AbortSignal
  ): Promise<SetupCodeRedeemDeviceResponse> {
    const body = setupCodeRedeemDeviceRequestSchema.parse(input);
    return this.postRedeem(body, setupCodeRedeemDeviceResponseSchema, signal);
  }

  private async postRedeem<T>(
    body: unknown,
    schema: {
      parse(value: unknown): T;
    },
    signal?: AbortSignal
  ): Promise<T> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.limits.requestTimeoutMs);
    const signals = [timeout.signal];
    if (signal) signals.push(signal);
    const combined = AbortSignal.any(signals);
    try {
      const response = await this.fetchImpl(new URL("/api/v1/setup-codes/redeem", this.serverBaseUrl), {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json; charset=utf-8"
        },
        body: JSON.stringify(body),
        signal: combined
      });
      const text = await response.text();
      if (!response.ok) {
        throw collaborationErrorFromHttp(response.status, text);
      }
      let value: unknown;
      try {
        value = text.length === 0 ? null : JSON.parse(text);
      } catch {
        throw new CollaborationClientError({
          kind: "protocol",
          code: "collaboration_malformed_json",
          message: "Setup-code redeem response was not valid JSON."
        });
      }
      return schema.parse(value);
    } catch (error) {
      if (error instanceof CollaborationClientError) throw error;
      throw collaborationErrorFromUnknown(error);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Redacted error text for setup-code failures — never includes the submitted code. */
export function setupCodeFailureMessage(error: unknown): string {
  if (error instanceof CollaborationClientError) {
    return redactCollaborationText(error.message);
  }
  if (error instanceof Error) {
    return redactCollaborationText(error.message);
  }
  return "setup_code_redeem_failed";
}
