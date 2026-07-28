import {
  setupCodeRedeemHostResponseSchema,
  type SetupCodeRedeemHostResponse
} from "@planweave-ai/collaboration-contracts";

const MAX_RESPONSE_BYTES = 16_384;
const JSON_CONTENT_TYPE = /^application\/json(?:;\s*charset=utf-8)?$/i;

export type HostSetupCodeRedeemRequest = {
  schemaVersion: "workspace-setup/v1";
  setupCode: string;
  purpose: "host_enrollment";
  displayName: string;
  capabilities: string[];
  capacity: number;
  enrollmentAttemptId: string;
  hostCredentialToken: string;
};

export function resolveSetupCodeRedeemEndpoint(
  coordinatorUrl: string,
  allowInsecureDevelopment = false
): URL {
  const endpoint = new URL(coordinatorUrl);
  if (endpoint.protocol === "wss:") endpoint.protocol = "https:";
  else if (endpoint.protocol === "ws:") {
    if (!allowInsecureDevelopment) throw new Error("agent_host_enrollment_transport_insecure");
    endpoint.protocol = "http:";
  } else if (endpoint.protocol === "http:") {
    if (!allowInsecureDevelopment) throw new Error("agent_host_enrollment_transport_insecure");
  } else if (endpoint.protocol !== "https:") {
    throw new Error("agent_host_enrollment_transport_unsupported");
  }
  endpoint.pathname = "/api/v1/setup-codes/redeem";
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!JSON_CONTENT_TYPE.test(response.headers.get("content-type") ?? "")) {
    throw new Error("agent_host_enrollment_response_malformed");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new Error("agent_host_enrollment_response_malformed");
    }
    if (parsedLength > MAX_RESPONSE_BYTES) {
      throw new Error("agent_host_enrollment_response_too_large");
    }
  }
  if (!response.body) throw new Error("agent_host_enrollment_response_malformed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("agent_host_enrollment_response_too_large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("agent_host_enrollment_response_malformed");
  }
}

export class HttpAgentHostSetupCodeRedeem {
  private readonly request: typeof fetch;

  constructor(
    private readonly coordinatorUrl: string,
    private readonly options: {
      allowInsecureDevelopment?: boolean;
      request?: typeof fetch;
    } = {}
  ) {
    this.request = options.request ?? fetch;
  }

  async redeem(
    input: HostSetupCodeRedeemRequest,
    signal?: AbortSignal
  ): Promise<SetupCodeRedeemHostResponse> {
    try {
      const response = await this.request(
        resolveSetupCodeRedeemEndpoint(
          this.coordinatorUrl,
          this.options.allowInsecureDevelopment === true
        ),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
          redirect: "error",
          signal
        }
      );
      const payload = await readBoundedJson(response);
      if (!response.ok) {
        throw new Error("agent_host_enrollment_rejected");
      }
      return setupCodeRedeemHostResponseSchema.parse(payload);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("agent_host_enrollment_")) {
        throw error;
      }
      throw new Error("agent_host_enrollment_exchange_failed");
    }
  }
}
