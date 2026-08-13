import { createHash } from "node:crypto";
import { z } from "zod";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.iso.datetime();
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const retainedStreamCategorySchema = z.enum([
  "operationEvents",
  "candidates",
  "actions",
  "interactions",
  "reservations",
  "acpStreams",
  "acpEvents",
  "historicalAttempts",
  "historicalDispatches",
  "historicalDispatchEvents",
  "historicalDispatchEnvelopes",
  "historicalArtifactGrants",
  "historicalArtifactLinks"
]);

const streamAuditSchema = z
  .object({ count: z.number().int().nonnegative(), digest: digestSchema })
  .strict();

const artifactProvenanceSchema = z
  .object({
    artifactRef: z.string().min(1),
    dispatchId: z.string().min(1),
    executionAttemptId: z.string().min(1),
    grantId: z.string().min(1),
    permission: z.enum(["input_read", "report_write", "output_write"]),
    purpose: z.enum(["input", "report", "output"]),
    producedByHostId: z.string().nullable(),
    logicalName: z.string().nullable(),
    expectedSha256: digestSchema
  })
  .strict();

export const remoteOperationRetentionSummarySchema = z
  .object({
    version: z.literal("remote-operation-retention-receipt/v1"),
    scope: z
      .object({
        workspaceId: z.string().min(1),
        projectId: z.string().min(1),
        canvasId: z.string().min(1)
      })
      .strict(),
    operation: z
      .object({
        operationId: z.string().min(1),
        terminalState: z.enum(["completed", "failed", "cancelled"]),
        terminalAt: timestampSchema,
        executionAttemptId: z.string().min(1),
        dispatchId: z.string().min(1),
        envelopeDigest: z.string().nullable()
      })
      .strict(),
    attempts: z
      .array(
        z
          .object({
            executionAttemptId: z.string().min(1),
            dispatchId: z.string().min(1),
            status: z.enum(["superseded", "completed", "failed", "cancelled"]),
            terminalAt: timestampSchema,
            dispatchStatus: z.enum(["completed", "failed", "cancelled"]),
            finishedAt: timestampSchema.nullable(),
            resultReferences: z
              .object({ reportArtifactRef: z.string(), artifactRefs: z.array(z.string()) })
              .strict()
              .nullable(),
            resultDigest: digestSchema.nullable(),
            failureCode: z.string().nullable(),
            failureDigest: digestSchema.nullable()
          })
          .strict()
      )
      .min(1),
    streams: z.record(retainedStreamCategorySchema, streamAuditSchema),
    historicalArtifactProvenance: z.array(artifactProvenanceSchema)
  })
  .strict();

export type RemoteOperationRetentionSummary = z.infer<typeof remoteOperationRetentionSummarySchema>;

export const retentionReceiptRowSchema = z
  .object({
    operation_id: z.string().min(1),
    receipt_digest: digestSchema,
    summary_json: z.string(),
    compacted_at: timestampSchema
  })
  .strict();

function normalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)])
    );
  }
  return value;
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(normalize(jsonValueSchema.parse(value)));
}

export function retentionDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function auditRows(rows: ReadonlyArray<Record<string, unknown>>): {
  count: number;
  digest: string;
} {
  const canonicalRows = rows
    .map((row) => canonicalJson(jsonValueSchema.parse(row)))
    .sort((left, right) => left.localeCompare(right));
  return {
    count: canonicalRows.length,
    digest: retentionDigest(canonicalJson(canonicalRows))
  };
}

export function serializeRetentionSummary(summary: RemoteOperationRetentionSummary): {
  summary: RemoteOperationRetentionSummary;
  json: string;
  digest: string;
} {
  const parsed = remoteOperationRetentionSummarySchema.parse(summary);
  const json = canonicalJson(parsed);
  return { summary: parsed, json, digest: retentionDigest(json) };
}

export function parseRetentionSummary(json: string): RemoteOperationRetentionSummary {
  return remoteOperationRetentionSummarySchema.parse(JSON.parse(json));
}
