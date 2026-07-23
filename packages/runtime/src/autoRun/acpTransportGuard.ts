import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ndJsonStream, type AnyMessage, type Stream } from "@agentclientprotocol/sdk";

export class AcpProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AcpProtocolError";
  }
}

export class AcpInboundMessageLimitError extends AcpProtocolError {
  constructor(readonly maxBytes: number) {
    super(`ACP transport message exceeded the ${maxBytes}-byte limit.`);
    this.name = "AcpInboundMessageLimitError";
  }
}

export type AcpProtocolObservation = {
  direction: "client_to_agent" | "agent_to_client" | "agent_stderr";
  payload: unknown;
};

export type AcpProtocolObserver = {
  redact(payload: unknown): unknown;
  observe(observation: AcpProtocolObservation): void;
};

function observe(
  observer: AcpProtocolObserver | undefined,
  direction: AcpProtocolObservation["direction"],
  payload: unknown
): void {
  if (!observer) return;
  observer.observe({ direction, payload: observer.redact(payload) });
}

function isJsonRpcId(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isTransportEnvelope(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  if (envelope.jsonrpc !== "2.0") return false;
  if ("method" in envelope) {
    if (typeof envelope.method !== "string") return false;
    if ("result" in envelope || "error" in envelope) return false;
    return !("id" in envelope) || isJsonRpcId(envelope.id);
  }
  if (!("id" in envelope) || !isJsonRpcId(envelope.id)) return false;
  return "result" in envelope !== "error" in envelope;
}

function validateTransportLine(line: string): void {
  let envelope: unknown;
  try {
    envelope = JSON.parse(line);
  } catch (error) {
    throw new AcpProtocolError("ACP transport received malformed JSON.", { cause: error });
  }
  if (!isTransportEnvelope(envelope)) {
    throw new AcpProtocolError("ACP transport received an invalid JSON-RPC envelope.");
  }
}

export function createGuardedAcpStream(options: {
  process: ChildProcessWithoutNullStreams;
  observer?: AcpProtocolObserver;
  fail(error: Error): void;
  maxInboundMessageBytes: number;
}): Stream {
  const decoder = new TextDecoder();
  let rawBuffer = "";
  let currentMessageBytes = 0;
  const rawGuard = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      for (const byte of chunk) {
        if (byte === 0x0a) {
          currentMessageBytes = 0;
          continue;
        }
        currentMessageBytes += 1;
        if (currentMessageBytes > options.maxInboundMessageBytes) {
          throw new AcpInboundMessageLimitError(options.maxInboundMessageBytes);
        }
      }
      rawBuffer += decoder.decode(chunk, { stream: true });
      const lines = rawBuffer.split("\n");
      rawBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        validateTransportLine(line);
      }
      controller.enqueue(chunk);
    },
    flush() {
      rawBuffer += decoder.decode();
      if (!rawBuffer.trim()) return;
      validateTransportLine(rawBuffer);
    }
  });
  const stdout = Readable.toWeb(options.process.stdout) as ReadableStream<Uint8Array>;
  const sdkStream = ndJsonStream(
    Writable.toWeb(options.process.stdin),
    stdout.pipeThrough(rawGuard)
  );
  const pendingIds = new Set<string>();
  const completedIds = new Set<string>();
  const idKey = (id: unknown): string => `${typeof id}:${String(id)}`;

  return {
    writable: new WritableStream<AnyMessage>({
      async write(message) {
        observe(options.observer, "client_to_agent", message);
        if ("method" in message && "id" in message) pendingIds.add(idKey(message.id));
        const writer = sdkStream.writable.getWriter();
        try {
          await writer.write(message);
        } finally {
          writer.releaseLock();
        }
      },
      async close() {
        const writer = sdkStream.writable.getWriter();
        try {
          await writer.close();
        } finally {
          writer.releaseLock();
        }
      },
      abort(reason) {
        return sdkStream.writable.abort(reason);
      }
    }),
    readable: new ReadableStream<AnyMessage>({
      async start(controller) {
        const reader = sdkStream.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            observe(options.observer, "agent_to_client", value);
            if ("id" in value && !("method" in value)) {
              const key = idKey(value.id);
              if (completedIds.has(key)) {
                throw new AcpProtocolError(`ACP duplicate response id: ${String(value.id)}`);
              }
              if (!pendingIds.delete(key)) {
                throw new AcpProtocolError(`ACP unknown response id: ${String(value.id)}`);
              }
              completedIds.add(key);
            }
            controller.enqueue(value);
          }
          controller.close();
        } catch (error) {
          const failure =
            error instanceof Error ? error : new Error("ACP transport failed.", { cause: error });
          options.fail(failure);
          controller.error(failure);
        } finally {
          reader.releaseLock();
        }
      },
      cancel(reason) {
        return sdkStream.readable.cancel(reason);
      }
    })
  };
}
