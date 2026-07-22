import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { ArtifactStore } from "./artifacts.js";
import { AgentHostRepository } from "./hosts.js";
import { authenticateAgentHostRequest } from "./hostTransportAuth.js";

export type ArtifactHttpOptions = {
  hosts: AgentHostRepository;
  artifacts: ArtifactStore;
  allowInsecureTransport?: boolean;
};

export type ArtifactHttpServer = {
  close(): void;
};

function route(url: string | undefined): { hostId: string; sha256: string } | undefined {
  if (!url) return undefined;
  const match = /^\/agent-hosts\/([^/]+)\/artifacts\/([a-f0-9]{64})(?:\?.*)?$/.exec(url);
  if (!match) return undefined;
  try {
    return { hostId: decodeURIComponent(match[1]), sha256: match[2] };
  } catch {
    return undefined;
  }
}

function respond(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength
  });
  response.end(bytes);
}

function requestHeader(value: string | string[] | undefined, name: string): string {
  const result = Array.isArray(value) ? value[0] : value;
  if (!result) throw new Error(`${name}_header_required`);
  return result;
}

export async function handleAgentHostArtifactRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ArtifactHttpOptions
): Promise<boolean> {
  const matched = route(request.url);
  if (!matched || (request.method !== "PUT" && request.method !== "GET")) return false;
  const authentication = authenticateAgentHostRequest(
    request,
    options.hosts,
    matched.hostId,
    options.allowInsecureTransport ?? false
  );
  if (!authentication.ok) {
    respond(response, authentication.status, { error: authentication.message });
    return true;
  }

  try {
    const ref = `artifact:sha256:${matched.sha256}`;
    if (request.method === "GET") {
      const { metadata, stream } = await options.artifacts.openRead(ref);
      response.writeHead(200, {
        "content-type": metadata.mediaType,
        "content-length": metadata.sizeBytes,
        etag: `"sha256:${metadata.sha256}"`,
        "cache-control": "private, immutable"
      });
      stream.on("error", () => response.destroy());
      stream.pipe(response);
      return true;
    }

    const contentLengthText = requestHeader(request.headers["content-length"], "content_length");
    const contentLength = Number(contentLengthText);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new Error("invalid_content_length");
    }
    if (contentLength > options.artifacts.maxArtifactBytes) {
      respond(response, 413, { error: "artifact_too_large" });
      request.resume();
      return true;
    }
    const mediaType = requestHeader(request.headers["content-type"], "content_type");
    const artifact = await options.artifacts.put({
      expectedSha256: matched.sha256,
      expectedSizeBytes: contentLength,
      mediaType,
      createdByHostId: authentication.host.id,
      chunks: request
    });
    respond(response, 201, artifact);
    return true;
  } catch (error) {
    respond(response, 400, {
      error: error instanceof Error ? error.message : "artifact_request_failed"
    });
    return true;
  }
}

export function attachAgentHostArtifactHttp(
  server: HttpServer,
  options: ArtifactHttpOptions
): ArtifactHttpServer {
  const listener = (request: IncomingMessage, response: ServerResponse) => {
    void handleAgentHostArtifactRequest(request, response, options).catch(() => {
      if (!response.headersSent) respond(response, 500, { error: "artifact_request_failed" });
      else response.destroy();
    });
  };
  server.on("request", listener);
  return { close: () => server.off("request", listener) };
}
