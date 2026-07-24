import { readFile } from "node:fs/promises";
import https from "node:https";
import { URL } from "node:url";

/**
 * Certificate-verified HTTPS request helper for local-tls-fixture and remote-vps.
 * Rejects NODE_TLS_REJECT_UNAUTHORIZED=0 so evidence never claims unverified TLS.
 */
export type TrustedFetch = {
  request: typeof fetch;
  close(): Promise<void>;
};

type HeaderMap = Record<string, string>;

function headersToObject(headers?: HeadersInit): HeaderMap {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: HeaderMap = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}

/**
 * Minimal Response-compatible wrapper for node:https (status/json/text only).
 */
class SimpleResponse {
  readonly status: number;
  readonly ok: boolean;
  private readonly bodyText: string;

  constructor(status: number, bodyText: string) {
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this.bodyText = bodyText;
  }

  async text(): Promise<string> {
    return this.bodyText;
  }

  async json(): Promise<unknown> {
    return JSON.parse(this.bodyText);
  }
}

function httpsRequest(
  url: URL,
  init: RequestInit | undefined,
  ca: string | undefined
): Promise<SimpleResponse> {
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = headersToObject(init?.headers);
  const body =
    init?.body === undefined || init.body === null
      ? undefined
      : typeof init.body === "string"
        ? init.body
        : Buffer.from(String(init.body));
  if (body !== undefined && !headers["content-length"] && !headers["Content-Length"]) {
    headers["content-length"] = String(Buffer.byteLength(body));
  }

  const isIpLiteral =
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname) || url.hostname === "[::1]" || url.hostname === "::1";

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        ca,
        // Node forbids SNI servername as an IP literal; IP SAN certs still verify via checkServerIdentity.
        ...(isIpLiteral ? {} : { servername: url.hostname }),
        minVersion: "TLSv1.2",
        rejectUnauthorized: true
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve(new SimpleResponse(response.statusCode ?? 0, Buffer.concat(chunks).toString("utf8")));
        });
      }
    );
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

export async function createTrustedFetch(options: {
  caCertificatePath?: string;
}): Promise<TrustedFetch> {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("vps_e2e_tls_verification_disabled");
  }
  if (!options.caCertificatePath) {
    return { request: fetch, async close() {} };
  }
  const ca = await readFile(options.caCertificatePath, "utf8");
  const request: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(String((input as Request).url));
    if (url.protocol === "http:") {
      return fetch(input as RequestInfo, init);
    }
    return httpsRequest(url, init, ca) as unknown as Response;
  };
  return { request, async close() {} };
}
