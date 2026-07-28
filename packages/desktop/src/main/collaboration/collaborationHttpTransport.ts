import {
  assertHumanDisplayDtoRedacted,
  collaborationClientLimitsSchema,
  collaborationServerOriginSchema,
  type CollaborationClientLimits,
} from "@planweave-ai/collaboration-contracts";
import type { ZodType } from "zod";
import {
  CollaborationClientError,
  collaborationErrorFromHttp,
  collaborationErrorFromUnknown
} from "./collaborationErrors.js";
import type {
  CollaborationClientClock,
  CollaborationCredentialPort
} from "./collaborationClientTypes.js";
import { systemCollaborationClock } from "./collaborationClientTypes.js";

export type JsonMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type CollaborationHttpTransportOptions = {
  serverBaseUrl: string;
  credential: CollaborationCredentialPort;
  limits?: Partial<CollaborationClientLimits>;
  request?: typeof fetch;
  clock?: CollaborationClientClock;
};

/**
 * Credential injection + bounded JSON HTTP transport for collaboration clients.
 * Callers never see raw Authorization headers or tokens.
 */
export class CollaborationHttpTransport {
  readonly serverBaseUrl: string;
  readonly limits: CollaborationClientLimits;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: CollaborationClientClock;
  private readonly credential: CollaborationCredentialPort;
  private readonly rootController = new AbortController();
  private disposed = false;

  constructor(options: CollaborationHttpTransportOptions) {
    this.serverBaseUrl = collaborationServerOriginSchema.parse(options.serverBaseUrl);
    this.limits = collaborationClientLimitsSchema.parse(options.limits ?? {});
    this.fetchImpl = options.request ?? fetch;
    this.clock = options.clock ?? systemCollaborationClock;
    this.credential = options.credential;
  }

  get disposedOrAborted(): boolean {
    return this.disposed || this.rootController.signal.aborted;
  }

  ensureOpen(): void {
    if (this.disposedOrAborted) {
      throw new CollaborationClientError({
        kind: "aborted",
        code: "collaboration_disposed",
        message: "CollaborationClient has been disposed."
      });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rootController.abort();
  }

  async applyAuth(headers: Record<string, string>): Promise<void> {
    const token = await this.credential.getDeviceToken();
    if (!token) {
      throw new CollaborationClientError({
        kind: "auth",
        code: "collaboration_credential_missing",
        message: "Human device credential is not available."
      });
    }
    headers.authorization = `Bearer ${token}`;
  }

  async jsonEmpty(
    method: JsonMethod,
    path: string,
    options: { body?: unknown; auth?: boolean; signal?: AbortSignal }
  ): Promise<void> {
    await this.json(method, path, undefined, options);
  }

  async json<T>(
    method: JsonMethod,
    path: string,
    schema: ZodType<T> | undefined,
    options: {
      body?: unknown;
      auth?: boolean;
      signal?: AbortSignal;
      /** HTTP statuses that still carry a contract body (e.g. canvas CAS 409). */
      acceptedStatus?: number | number[];
    } = {}
  ): Promise<T> {
    this.ensureOpen();
    const headers: Record<string, string> = {
      accept: "application/json"
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json; charset=utf-8";
    }
    if (options.auth !== false) {
      await this.applyAuth(headers);
    }
    const response = await this.send(path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal
    });
    const text = await this.readTextLimited(response);
    const accepted = normalizeAccepted(options.acceptedStatus);
    if (!response.ok && !accepted.has(response.status)) {
      throw collaborationErrorFromHttp(response.status, text);
    }
    if (schema === undefined) {
      if (text.length === 0) return undefined as T;
      try {
        JSON.parse(text);
      } catch {
        throw new CollaborationClientError({
          kind: "protocol",
          code: "collaboration_malformed_json",
          message: "Response was not valid JSON."
        });
      }
      return undefined as T;
    }
    let value: unknown;
    try {
      value = text.length === 0 ? null : JSON.parse(text);
    } catch {
      throw new CollaborationClientError({
        kind: "protocol",
        code: "collaboration_malformed_json",
        message: "Response was not valid JSON."
      });
    }
    try {
      const parsed = schema.parse(value);
      assertHumanDisplayDtoRedacted(parsed);
      return parsed;
    } catch (error) {
      throw new CollaborationClientError({
        kind: "protocol",
        code: "collaboration_response_invalid",
        message: "Response failed contract validation.",
        cause: error
      });
    }
  }

  async jsonNullable<T>(
    method: JsonMethod,
    path: string,
    schema: ZodType<T>,
    options: { body?: unknown; auth?: boolean; signal?: AbortSignal } = {}
  ): Promise<T | null> {
    this.ensureOpen();
    const headers: Record<string, string> = {
      accept: "application/json"
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json; charset=utf-8";
    }
    if (options.auth !== false) {
      await this.applyAuth(headers);
    }
    const response = await this.send(path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal
    });
    const text = await this.readTextLimited(response);
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
        message: "Response was not valid JSON."
      });
    }
    if (value === null) return null;
    try {
      const parsed = schema.parse(value);
      assertHumanDisplayDtoRedacted(parsed);
      return parsed;
    } catch (error) {
      throw new CollaborationClientError({
        kind: "protocol",
        code: "collaboration_response_invalid",
        message: "Response failed contract validation.",
        cause: error
      });
    }
  }

  async send(
    path: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body?: string | Uint8Array;
      signal?: AbortSignal;
    }
  ): Promise<Response> {
    const url = new URL(path, this.serverBaseUrl);
    const timeout = new AbortController();
    const timer = this.clock.setTimeout(() => timeout.abort(), this.limits.requestTimeoutMs);
    const signals = [this.rootController.signal, timeout.signal];
    if (init.signal) signals.push(init.signal);
    const signal = AbortSignal.any(signals);
    try {
      const body: BodyInit | undefined =
        init.body === undefined
          ? undefined
          : typeof init.body === "string"
            ? init.body
            : Buffer.from(init.body);
      return await this.fetchImpl(url, {
        method: init.method,
        headers: init.headers,
        body,
        signal
      });
    } catch (error) {
      if (signal.aborted && timeout.signal.aborted && !this.rootController.signal.aborted) {
        throw new CollaborationClientError({
          kind: "timeout",
          code: "collaboration_timeout",
          message: "Collaboration request timed out.",
          retryable: true,
          cause: error
        });
      }
      throw collaborationErrorFromUnknown(error);
    } finally {
      this.clock.clearTimeout(timer);
    }
  }

  private async readTextLimited(response: Response): Promise<string> {
    const declared = response.headers.get("content-length");
    if (declared && /^\d+$/.test(declared) && Number(declared) > this.limits.jsonBodyMaxBytes) {
      throw new CollaborationClientError({
        kind: "payload_too_large",
        code: "collaboration_response_too_large",
        message: "Response exceeded body size limit.",
        httpStatus: response.status
      });
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > this.limits.jsonBodyMaxBytes) {
      throw new CollaborationClientError({
        kind: "payload_too_large",
        code: "collaboration_response_too_large",
        message: "Response exceeded body size limit.",
        httpStatus: response.status
      });
    }
    return Buffer.from(buffer).toString("utf8");
  }
}

function normalizeAccepted(value: number | number[] | undefined): Set<number> {
  if (value === undefined) return new Set();
  return new Set(Array.isArray(value) ? value : [value]);
}
