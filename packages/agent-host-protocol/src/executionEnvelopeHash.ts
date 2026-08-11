import { createHash } from "node:crypto";
import {
  canonicalizeExecutionEnvelope,
  executionEnvelopeDigestAlgorithm,
  executionEnvelopeDigestPrefix,
  executionEnvelopeDigestSchema,
  parseExecutionEnvelope,
  type ExecutionEnvelope,
  type ExecutionEnvelopeDigest
} from "./executionEnvelope.js";

export function hashExecutionEnvelope(envelope: ExecutionEnvelope): ExecutionEnvelopeDigest {
  const canonical = canonicalizeExecutionEnvelope(envelope);
  const digest = createHash(executionEnvelopeDigestAlgorithm)
    .update(canonical, "utf8")
    .digest("hex");
  return executionEnvelopeDigestSchema.parse(`${executionEnvelopeDigestPrefix}${digest}`);
}

export function parseAndHashExecutionEnvelope(input: unknown): {
  envelope: ExecutionEnvelope;
  digest: ExecutionEnvelopeDigest;
} {
  const envelope = parseExecutionEnvelope(input);
  return { envelope, digest: hashExecutionEnvelope(envelope) };
}
