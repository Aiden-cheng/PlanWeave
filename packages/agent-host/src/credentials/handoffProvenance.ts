import { createHash } from "node:crypto";
import {
  agentHostSetupHandoffSchema,
  canonicalizeJson,
  type AgentHostSetupHandoff
} from "@planweave-ai/agent-host-protocol";
import { z } from "zod";
import type { AgentHostConfig } from "../config/schema.js";

const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const pendingPortableHandoffProvenanceSchema = z
  .object({
    kind: z.literal("portable_handoff"),
    handoffDigest: sha256DigestSchema,
    endpointWorkspaceBindingDigest: sha256DigestSchema,
    acceptedAt: z.string().datetime()
  })
  .strict();

export const activePortableHandoffProvenanceSchema = pendingPortableHandoffProvenanceSchema
  .extend({
    credentialBindingDigest: sha256DigestSchema,
    consumedAt: z.string().datetime()
  })
  .strict()
  .refine(
    (value) => Date.parse(value.consumedAt) >= Date.parse(value.acceptedAt),
    "Portable handoff consumption cannot precede acceptance."
  );

export type PendingPortableHandoffProvenance = z.infer<
  typeof pendingPortableHandoffProvenanceSchema
>;
export type ActivePortableHandoffProvenance = z.infer<typeof activePortableHandoffProvenanceSchema>;

type CredentialBinding = {
  hostId: string;
  workspaceId: string;
  credentialToken: string;
  issuedAt: string;
  expiresAt: string;
};

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex");
}

function endpointWorkspaceBindingDigest(
  handoffDigest: string,
  acceptedAt: string,
  endpoint: AgentHostSetupHandoff["endpoint"],
  workspaceId: string
): string {
  return digest({ acceptedAt, endpoint, handoffDigest, workspaceId });
}

function pendingFields(
  provenance: PendingPortableHandoffProvenance | ActivePortableHandoffProvenance
): PendingPortableHandoffProvenance {
  return {
    kind: provenance.kind,
    handoffDigest: provenance.handoffDigest,
    endpointWorkspaceBindingDigest: provenance.endpointWorkspaceBindingDigest,
    acceptedAt: provenance.acceptedAt
  };
}

function credentialFields(credential: CredentialBinding): CredentialBinding {
  return {
    hostId: credential.hostId,
    workspaceId: credential.workspaceId,
    credentialToken: credential.credentialToken,
    issuedAt: credential.issuedAt,
    expiresAt: credential.expiresAt
  };
}

export function createPendingPortableHandoffProvenance(
  input: AgentHostSetupHandoff,
  acceptedAt: Date
): PendingPortableHandoffProvenance {
  const handoff = agentHostSetupHandoffSchema.parse(input);
  const handoffDigest = digest(handoff);
  const acceptedAtValue = acceptedAt.toISOString();
  return pendingPortableHandoffProvenanceSchema.parse({
    kind: "portable_handoff",
    handoffDigest,
    endpointWorkspaceBindingDigest: endpointWorkspaceBindingDigest(
      handoffDigest,
      acceptedAtValue,
      handoff.endpoint,
      handoff.workspaceId
    ),
    acceptedAt: acceptedAtValue
  });
}

export function portableHandoffPendingWorkspaceId(
  provenance: PendingPortableHandoffProvenance,
  config: AgentHostConfig
): string | null {
  const endpoint = config.coordinator.endpoint;
  if (!endpoint) return null;
  const matches = config.workspaces.filter(
    (workspace) =>
      endpointWorkspaceBindingDigest(
        provenance.handoffDigest,
        provenance.acceptedAt,
        endpoint,
        workspace.id
      ) === provenance.endpointWorkspaceBindingDigest
  );
  return matches.length === 1 ? matches[0].id : null;
}

export function portableHandoffConfigMatches(
  handoff: AgentHostSetupHandoff,
  config: AgentHostConfig
): boolean {
  const endpoint = config.coordinator.endpoint;
  return (
    endpoint !== undefined &&
    canonicalizeJson(endpoint) === canonicalizeJson(handoff.endpoint) &&
    config.workspaces.some((workspace) => workspace.id === handoff.workspaceId)
  );
}

export function pendingProvenanceMatchesHandoff(
  provenance: PendingPortableHandoffProvenance,
  handoff: AgentHostSetupHandoff,
  config: AgentHostConfig
): boolean {
  const expected = createPendingPortableHandoffProvenance(handoff, new Date(provenance.acceptedAt));
  return (
    provenance.handoffDigest === expected.handoffDigest &&
    provenance.endpointWorkspaceBindingDigest === expected.endpointWorkspaceBindingDigest &&
    portableHandoffPendingWorkspaceId(provenance, config) === handoff.workspaceId
  );
}

export function consumePortableHandoffProvenance(
  provenance: PendingPortableHandoffProvenance,
  credential: CredentialBinding,
  consumedAt: Date
): ActivePortableHandoffProvenance {
  const pending = pendingPortableHandoffProvenanceSchema.parse(provenance);
  const consumedAtValue = consumedAt.toISOString();
  return activePortableHandoffProvenanceSchema.parse({
    ...pending,
    credentialBindingDigest: digest({
      credential: credentialFields(credential),
      provenance: pending,
      consumedAt: consumedAtValue
    }),
    consumedAt: consumedAtValue
  });
}

export function verifyActivePortableHandoffProvenance(
  credential: CredentialBinding & { provenance?: ActivePortableHandoffProvenance },
  config: AgentHostConfig
): boolean {
  const provenance = credential.provenance;
  if (!provenance) return false;
  const parsed = activePortableHandoffProvenanceSchema.safeParse(provenance);
  if (!parsed.success) return false;
  const pending = pendingFields(parsed.data);
  if (portableHandoffPendingWorkspaceId(pending, config) !== credential.workspaceId) return false;
  return (
    digest({
      credential: credentialFields(credential),
      provenance: pending,
      consumedAt: parsed.data.consumedAt
    }) === parsed.data.credentialBindingDigest
  );
}
