import {
  hostCredentialPolicySchema,
  hostReadinessObservationSchema,
  type HostCredentialPolicy,
  type HostReadinessObservation
} from "@planweave-ai/agent-host-protocol";
import { capabilitiesSchema } from "./protocol.js";

export type AgentHost = {
  id: string;
  displayName: string;
  capabilities: string[];
  capacity: number;
  lastSeenAt?: string;
  lastAcknowledgedSequence: number;
  revokedAt?: string;
  credentialExpiresAt?: string;
  credentialPolicy?: HostCredentialPolicy;
  credentialRenewalRequestedAt?: string;
  readinessObservation?: HostReadinessObservation;
};

export type HostRow = Record<string, unknown> & {
  id: string;
  display_name: string;
  credential_hash: string;
  capabilities_json: string;
  capacity: number;
  last_seen_at: string | null;
  last_acknowledged_sequence: number;
  revoked_at: string | null;
  credential_expires_at: string | null;
  credential_lifetime_days: number | null;
  credential_renewal_requested_at: string | null;
  readiness_json?: string | null;
};

export function toAgentHost(row: HostRow): AgentHost {
  return {
    id: row.id,
    displayName: row.display_name,
    capabilities: capabilitiesSchema.parse(JSON.parse(row.capabilities_json)),
    capacity: Number(row.capacity),
    lastSeenAt: row.last_seen_at ?? undefined,
    lastAcknowledgedSequence: Number(row.last_acknowledged_sequence),
    revokedAt: row.revoked_at ?? undefined,
    credentialExpiresAt: row.credential_expires_at ?? undefined,
    credentialPolicy:
      row.credential_lifetime_days === null
        ? undefined
        : hostCredentialPolicySchema.parse({
            lifetimeDays: row.credential_lifetime_days,
            renewal: "automatic"
          }),
    credentialRenewalRequestedAt: row.credential_renewal_requested_at ?? undefined,
    readinessObservation: row.readiness_json
      ? hostReadinessObservationSchema.parse(JSON.parse(row.readiness_json))
      : undefined
  };
}
