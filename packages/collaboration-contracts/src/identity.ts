import { z } from "zod";
import {
  HUMAN_MAX_DEVICES_LISTED_PER_PAGE,
  HUMAN_MAX_INVITATIONS_LISTED_PER_PAGE,
  HUMAN_MAX_MEMBERS_LISTED_PER_PAGE
} from "./limits.js";
import {
  agentHostIdSchema,
  credentialSha256Schema,
  deviceSessionIdSchema,
  humanDeviceCredentialIdSchema,
  humanDeviceLabelSchema,
  humanDeviceTokenSchema,
  humanDeviceTtlMsSchema,
  humanDisplayNameSchema,
  humanMembershipIdSchema,
  humanPrincipalIdSchema,
  humanProjectIdSchema,
  hostEnrollmentIdSchema,
  identityCredentialStateSchema,
  identityRevocationIdSchema,
  operatorIdSchema,
  operatorSessionIdSchema,
  workspaceIdentitySchemaVersionSchema,
  workspaceIdSchema,
  workspaceNameSchema,
  workspaceRoleSchema,
  type WorkspaceScopeRef,
  projectInvitationIdSchema,
  projectInvitationTokenSchema,
  projectInvitationTtlMsSchema,
  projectMemberRoleSchema,
  projectMembershipIdSchema,
  timestampSchema
} from "./primitives.js";

const hostCapabilitySchema = z.string().trim().min(1).max(128);
const hostCapabilitiesSchema = z
  .array(hostCapabilitySchema)
  .max(128)
  .superRefine((values, ctx) => {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: "custom", message: "duplicate_host_capability" });
    }
  });

const nullableTimestampSchema = timestampSchema.nullable();

/** Exported trust-boundary ownership for each consumer. */
export const identityContractOwnership = {
  server: {
    creates: [
      "workspace",
      "human_principal",
      "membership",
      "device_session",
      "operator_session",
      "agent_host",
      "host_enrollment",
      "revocation"
    ],
    authenticates: ["device_session", "operator_session", "agent_host"]
  },
  desktop: {
    consumes: [
      "workspace_identity_view",
      "human_principal_view",
      "membership_view",
      "device_session_view",
      "agent_host_view"
    ]
  },
  agentHost: {
    consumes: ["agent_host_credential_binding", "workspace_scope_ref"]
  }
} as const;
export const workspaceIdentityContractOwnership = identityContractOwnership;

/** Durable Workspace identity created and authenticated by Server only. */
export const workspaceSchema = z
  .object({
    schemaVersion: workspaceIdentitySchemaVersionSchema,
    workspaceId: workspaceIdSchema,
    displayName: workspaceNameSchema,
    createdAt: timestampSchema,
    archivedAt: nullableTimestampSchema
  })
  .strict();
export type Workspace = z.infer<typeof workspaceSchema>;

/** Human principal is global to one Workspace, never to a project root. */
export const humanPrincipalSchema = z
  .object({
    schemaVersion: workspaceIdentitySchemaVersionSchema,
    workspaceId: workspaceIdSchema,
    humanPrincipalId: humanPrincipalIdSchema,
    displayName: humanDisplayNameSchema,
    createdAt: timestampSchema,
    revokedAt: nullableTimestampSchema
  })
  .strict();
export type WorkspaceHumanPrincipal = z.infer<typeof humanPrincipalSchema>;

export const workspaceMembershipSchema = z
  .object({
    schemaVersion: workspaceIdentitySchemaVersionSchema,
    workspaceId: workspaceIdSchema,
    membershipId: humanMembershipIdSchema,
    humanPrincipalId: humanPrincipalIdSchema,
    role: workspaceRoleSchema,
    revision: z.number().int().positive(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    revokedAt: nullableTimestampSchema
  })
  .strict();
export type WorkspaceMembership = z.infer<typeof workspaceMembershipSchema>;

/** Server durable device session metadata. Plaintext bearer tokens are never accepted here. */
export const deviceSessionSchema = z
  .object({
    schemaVersion: workspaceIdentitySchemaVersionSchema,
    workspaceId: workspaceIdSchema,
    deviceSessionId: deviceSessionIdSchema,
    humanPrincipalId: humanPrincipalIdSchema,
    credentialSha256: credentialSha256Schema,
    issuedAt: timestampSchema,
    expiresAt: nullableTimestampSchema,
    revokedAt: nullableTimestampSchema,
    lastUsedAt: nullableTimestampSchema
  })
  .strict();
export type DeviceSession = z.infer<typeof deviceSessionSchema>;

/** Authenticated human session context; no token material is forwarded to Desktop. */
export const humanDeviceSessionContextSchema = z
  .object({
    schemaVersion: workspaceIdentitySchemaVersionSchema,
    workspaceId: workspaceIdSchema,
    deviceSessionId: deviceSessionIdSchema,
    humanPrincipalId: humanPrincipalIdSchema,
    membershipId: humanMembershipIdSchema,
    role: workspaceRoleSchema,
    expiresAt: nullableTimestampSchema,
    revokedAt: nullableTimestampSchema
  })
  .strict();
export type HumanDeviceSessionContext = z.infer<typeof humanDeviceSessionContextSchema>;

/** Operator session is a separate trust domain from human and Agent Host credentials. */
export const operatorSessionSchema = z
  .object({
    schemaVersion: workspaceIdentitySchemaVersionSchema,
    workspaceId: workspaceIdSchema,
    operatorSessionId: operatorSessionIdSchema,
    operatorId: operatorIdSchema,
    credentialSha256: credentialSha256Schema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    revokedAt: nullableTimestampSchema
  })
  .strict();
export type OperatorSession = z.infer<typeof operatorSessionSchema>;

export const operatorSessionContextSchema = z
  .object({
    schemaVersion: workspaceIdentitySchemaVersionSchema,
    workspaceId: workspaceIdSchema,
    operatorSessionId: operatorSessionIdSchema,
    operatorId: operatorIdSchema,
    expiresAt: timestampSchema,
    revokedAt: nullableTimestampSchema
  })
  .strict();
export type OperatorSessionContext = z.infer<typeof operatorSessionContextSchema>;

/** Server-side Agent Host identity. Host secrets remain on the Host and are represented by a digest. */
export const agentHostIdentitySchema = z
  .object({
    schemaVersion: workspaceIdentitySchemaVersionSchema,
    workspaceId: workspaceIdSchema,
    hostId: agentHostIdSchema,
    displayName: workspaceNameSchema,
    capabilities: hostCapabilitiesSchema,
    capacity: z.number().int().min(1).max(128),
    credentialSha256: credentialSha256Schema,
    createdAt: timestampSchema,
    lastSeenAt: nullableTimestampSchema,
    credentialExpiresAt: nullableTimestampSchema,
    revokedAt: nullableTimestampSchema
  })
  .strict();
export type AgentHostIdentity = z.infer<typeof agentHostIdentitySchema>;

/** One-time enrollment grant persisted by Server; only hashes are durable. */
export const agentHostEnrollmentSchema = z
  .object({
    schemaVersion: workspaceIdentitySchemaVersionSchema,
    workspaceId: workspaceIdSchema,
    enrollmentId: hostEnrollmentIdSchema,
    enrollmentCodeSha256: credentialSha256Schema,
    credentialExpiresAt: timestampSchema,
    expiresAt: timestampSchema,
    usedAt: nullableTimestampSchema,
    hostId: agentHostIdSchema.nullable(),
    revokedAt: nullableTimestampSchema,
    createdAt: timestampSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    const used = value.usedAt !== null;
    if (used !== (value.hostId !== null)) {
      ctx.addIssue({ code: "custom", message: "enrollment_use_marker_mismatch" });
    }
    if (Date.parse(value.expiresAt) >= Date.parse(value.credentialExpiresAt)) {
      ctx.addIssue({ code: "custom", message: "enrollment_credential_expiry_order_invalid" });
    }
  });
export type AgentHostEnrollment = z.infer<typeof agentHostEnrollmentSchema>;

/** Redaction-safe Host credential held only by the Host process. */
export const agentHostCredentialBindingSchema = z
  .object({
    schemaVersion: workspaceIdentitySchemaVersionSchema,
    workspaceId: workspaceIdSchema,
    hostId: agentHostIdSchema,
    credentialToken: z.string().regex(/^pw_host_[A-Za-z0-9_-]{43}$/),
    credentialExpiresAt: timestampSchema
  })
  .strict();
export type AgentHostCredentialBinding = z.infer<typeof agentHostCredentialBindingSchema>;

export const identityRevocationSchema = z
  .object({
    schemaVersion: workspaceIdentitySchemaVersionSchema,
    revocationId: identityRevocationIdSchema,
    workspaceId: workspaceIdSchema,
    /**
     * Includes setup_code so Server can audit one-time onboarding grants alongside
     * durable identity subjects. Setup-code lifecycle details live in setup.ts.
     */
    subjectKind: z.enum([
      "human_principal",
      "device_session",
      "operator_session",
      "agent_host",
      "enrollment",
      "setup_code"
    ]),
    subjectId: z.string().min(1).max(128),
    revokedAt: timestampSchema,
    reason: z.string().trim().min(1).max(512)
  })
  .strict();
export type IdentityRevocation = z.infer<typeof identityRevocationSchema>;

/**
 * Maps a setup-code purpose to the durable credential domain it may mint.
 * Used by Server redeem paths and contract tests to reject type confusion.
 */
export const setupPurposeCredentialDomain = {
  device_session: "human_device",
  operator_session: "operator",
  host_enrollment: "agent_host"
} as const;

/** Desktop-facing projections contain identity metadata only, never digests or bearer secrets. */
export const workspaceIdentityViewSchema = z
  .object({
    schemaVersion: workspaceIdentitySchemaVersionSchema,
    workspaceId: workspaceIdSchema,
    displayName: workspaceNameSchema,
    createdAt: timestampSchema,
    archivedAt: nullableTimestampSchema
  })
  .strict();
export type WorkspaceIdentityView = z.infer<typeof workspaceIdentityViewSchema>;

export const workspaceHumanPrincipalViewSchema = z
  .object({
    schemaVersion: workspaceIdentitySchemaVersionSchema,
    workspaceId: workspaceIdSchema,
    humanPrincipalId: humanPrincipalIdSchema,
    displayName: humanDisplayNameSchema,
    createdAt: timestampSchema,
    revokedAt: nullableTimestampSchema
  })
  .strict();
export type WorkspaceHumanPrincipalView = z.infer<typeof workspaceHumanPrincipalViewSchema>;

export const workspaceMembershipViewSchema = z
  .object({
    schemaVersion: workspaceIdentitySchemaVersionSchema,
    workspaceId: workspaceIdSchema,
    membershipId: humanMembershipIdSchema,
    humanPrincipalId: humanPrincipalIdSchema,
    displayName: humanDisplayNameSchema,
    role: workspaceRoleSchema,
    revision: z.number().int().positive(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    revokedAt: nullableTimestampSchema
  })
  .strict();
export type WorkspaceMembershipView = z.infer<typeof workspaceMembershipViewSchema>;

export const deviceSessionViewSchema = z
  .object({
    schemaVersion: workspaceIdentitySchemaVersionSchema,
    workspaceId: workspaceIdSchema,
    deviceSessionId: deviceSessionIdSchema,
    humanPrincipalId: humanPrincipalIdSchema,
    issuedAt: timestampSchema,
    expiresAt: nullableTimestampSchema,
    revokedAt: nullableTimestampSchema,
    lastUsedAt: nullableTimestampSchema
  })
  .strict();
export type DeviceSessionView = z.infer<typeof deviceSessionViewSchema>;

export const agentHostIdentityViewSchema = z
  .object({
    schemaVersion: workspaceIdentitySchemaVersionSchema,
    workspaceId: workspaceIdSchema,
    hostId: agentHostIdSchema,
    displayName: workspaceNameSchema,
    capabilities: hostCapabilitiesSchema,
    capacity: z.number().int().min(1).max(128),
    lastSeenAt: nullableTimestampSchema,
    credentialExpiresAt: nullableTimestampSchema,
    revokedAt: nullableTimestampSchema
  })
  .strict();
export type AgentHostIdentityView = z.infer<typeof agentHostIdentityViewSchema>;

/** Public principal view — never digests or secrets. */
export const humanPrincipalViewSchema = z
  .object({
    humanPrincipalId: humanPrincipalIdSchema,
    displayName: humanDisplayNameSchema,
    createdAt: timestampSchema
  })
  .strict();
export type HumanPrincipalView = z.infer<typeof humanPrincipalViewSchema>;

export const humanMembershipViewSchema = z
  .object({
    membershipId: projectMembershipIdSchema,
    projectId: humanProjectIdSchema,
    humanPrincipalId: humanPrincipalIdSchema,
    displayName: humanDisplayNameSchema,
    role: projectMemberRoleSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema
  })
  .strict();
export type HumanMembershipView = z.infer<typeof humanMembershipViewSchema>;

export const humanDeviceViewSchema = z
  .object({
    deviceCredentialId: humanDeviceCredentialIdSchema,
    humanPrincipalId: humanPrincipalIdSchema,
    mintedForProjectId: humanProjectIdSchema,
    label: z.string().min(1).max(64).optional(),
    createdAt: timestampSchema,
    expiresAt: timestampSchema.optional(),
    revokedAt: timestampSchema.optional(),
    lastUsedAt: timestampSchema.optional()
  })
  .strict();
export type HumanDeviceView = z.infer<typeof humanDeviceViewSchema>;

export const humanInvitationViewSchema = z
  .object({
    invitationId: projectInvitationIdSchema,
    projectId: humanProjectIdSchema,
    role: z.literal("member"),
    createdByHumanPrincipalId: humanPrincipalIdSchema,
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
    revokedAt: timestampSchema.optional(),
    consumedAt: timestampSchema.optional()
  })
  .strict();
export type HumanInvitationView = z.infer<typeof humanInvitationViewSchema>;

export const humanMemberPageSchema = z
  .object({
    items: z.array(humanMembershipViewSchema).max(HUMAN_MAX_MEMBERS_LISTED_PER_PAGE),
    nextCursor: z.number().int().nonnegative().nullable()
  })
  .strict();
export type HumanMemberPage = z.infer<typeof humanMemberPageSchema>;

export const humanDevicePageSchema = z
  .object({
    items: z.array(humanDeviceViewSchema).max(HUMAN_MAX_DEVICES_LISTED_PER_PAGE),
    nextCursor: z.number().int().nonnegative().nullable()
  })
  .strict();
export type HumanDevicePage = z.infer<typeof humanDevicePageSchema>;

export const humanInvitationPageSchema = z
  .object({
    items: z.array(humanInvitationViewSchema).max(HUMAN_MAX_INVITATIONS_LISTED_PER_PAGE),
    nextCursor: z.number().int().nonnegative().nullable()
  })
  .strict();
export type HumanInvitationPage = z.infer<typeof humanInvitationPageSchema>;

export const humanRevokeInvitationsRequestSchema = z
  .object({
    invitationIds: z
      .array(projectInvitationIdSchema)
      .min(1)
      .max(HUMAN_MAX_INVITATIONS_LISTED_PER_PAGE)
      .superRefine((values, ctx) => {
        if (new Set(values).size !== values.length) {
          ctx.addIssue({ code: "custom", message: "duplicate_invitation_id" });
        }
      })
  })
  .strict();
export type HumanRevokeInvitationsRequest = z.infer<typeof humanRevokeInvitationsRequestSchema>;

export const humanRevokeInvitationsResponseSchema = z
  .object({
    items: z.array(humanInvitationViewSchema).max(HUMAN_MAX_INVITATIONS_LISTED_PER_PAGE)
  })
  .strict();
export type HumanRevokeInvitationsResponse = z.infer<typeof humanRevokeInvitationsResponseSchema>;

export const humanBootstrapRequestSchema = z
  .object({
    displayName: humanDisplayNameSchema,
    humanPrincipalId: humanPrincipalIdSchema.optional(),
    deviceLabel: humanDeviceLabelSchema.optional(),
    deviceTtlMs: humanDeviceTtlMsSchema.optional()
  })
  .strict();
export type HumanBootstrapRequest = z.infer<typeof humanBootstrapRequestSchema>;

export const humanBootstrapResponseSchema = z
  .object({
    principal: humanPrincipalViewSchema,
    membership: humanMembershipViewSchema,
    device: humanDeviceViewSchema,
    deviceToken: humanDeviceTokenSchema.optional(),
    created: z.boolean()
  })
  .strict();
export type HumanBootstrapResponse = z.infer<typeof humanBootstrapResponseSchema>;

export const humanCreateInvitationRequestSchema = z
  .object({
    ttlMs: projectInvitationTtlMsSchema.optional()
  })
  .strict();
export type HumanCreateInvitationRequest = z.infer<typeof humanCreateInvitationRequestSchema>;

export const humanCreateInvitationResponseSchema = z
  .object({
    invitation: humanInvitationViewSchema,
    invitationToken: projectInvitationTokenSchema
  })
  .strict();
export type HumanCreateInvitationResponse = z.infer<typeof humanCreateInvitationResponseSchema>;

export const humanConsumeInvitationRequestSchema = z
  .object({
    invitationToken: projectInvitationTokenSchema,
    displayName: humanDisplayNameSchema,
    deviceLabel: humanDeviceLabelSchema.optional(),
    deviceTtlMs: humanDeviceTtlMsSchema.optional(),
    existingDeviceToken: humanDeviceTokenSchema.optional()
  })
  .strict();
export type HumanConsumeInvitationRequest = z.infer<typeof humanConsumeInvitationRequestSchema>;

export const humanConsumeInvitationResponseSchema = z
  .object({
    principal: humanPrincipalViewSchema,
    membership: humanMembershipViewSchema,
    device: humanDeviceViewSchema,
    deviceToken: humanDeviceTokenSchema,
    invitation: humanInvitationViewSchema,
    principalCreated: z.boolean()
  })
  .strict();
export type HumanConsumeInvitationResponse = z.infer<typeof humanConsumeInvitationResponseSchema>;

export const humanPageQuerySchema = z
  .object({
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(50)
  })
  .strict();
export type HumanPageQuery = z.infer<typeof humanPageQuerySchema>;

export const humanInvitationListQuerySchema = z
  .object({
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(50),
    openOnly: z.boolean().optional()
  })
  .strict();
export type HumanInvitationListQuery = z.infer<typeof humanInvitationListQuerySchema>;

export const humanDeviceListQuerySchema = z
  .object({
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(50),
    scope: z.enum(["own", "project"]).default("own")
  })
  .strict();
export type HumanDeviceListQuery = z.infer<typeof humanDeviceListQuerySchema>;

/** Ensures serialized bodies never leak digests. */
export function assertHumanDisplayDtoRedacted(value: unknown): void {
  const text = JSON.stringify(value);
  if (text.includes("tokenSha256") || text.includes("token_sha256")) {
    throw new Error("human_dto_digest_leak");
  }
}

export function assertWorkspaceIdentityViewRedacted(value: unknown): void {
  const forbiddenKey =
    /^(?:credential(?:Sha256|Hash|Token)|credential[_-](?:sha256|hash|token)|token(?:Sha256|Hash|Token)?|token[_-](?:sha256|hash|token)|secret|password|enrollment(?:Code|Hash)|enrollment[_-](?:code|hash)|projectRoot|executable|command|args|environment|env)$/i;
  const visit = (current: unknown): boolean => {
    if (Array.isArray(current)) return current.some(visit);
    if (!current || typeof current !== "object") return false;
    return Object.entries(current).some(([key, nested]) => {
      if (forbiddenKey.test(key)) return true;
      return visit(nested);
    });
  };
  if (visit(value)) throw new Error("workspace_identity_view_not_redacted");
}

export type IdentityCredentialUsability =
  | { usable: true; state: "active" }
  | {
      usable: false;
      state:
        | Exclude<z.infer<typeof identityCredentialStateSchema>, "active">
        | "workspace_mismatch";
    };

function evaluateCredentialUsability(input: {
  workspaceId: string;
  expectedWorkspaceId: string;
  expiresAt: string | null;
  revokedAt: string | null;
  now: Date;
}): IdentityCredentialUsability {
  if (input.workspaceId !== input.expectedWorkspaceId) {
    return { usable: false, state: "workspace_mismatch" };
  }
  if (input.revokedAt !== null) return { usable: false, state: "revoked" };
  if (input.expiresAt !== null && Date.parse(input.expiresAt) <= input.now.getTime()) {
    return { usable: false, state: "expired" };
  }
  return { usable: true, state: "active" };
}

export function evaluateDeviceSessionUsability(input: {
  session: DeviceSession;
  workspaceId: string;
  now: Date;
}): IdentityCredentialUsability {
  return evaluateCredentialUsability({
    workspaceId: input.session.workspaceId,
    expectedWorkspaceId: input.workspaceId,
    expiresAt: input.session.expiresAt,
    revokedAt: input.session.revokedAt,
    now: input.now
  });
}

export function evaluateOperatorSessionUsability(input: {
  session: OperatorSession;
  workspaceId: string;
  now: Date;
}): IdentityCredentialUsability {
  return evaluateCredentialUsability({
    workspaceId: input.session.workspaceId,
    expectedWorkspaceId: input.workspaceId,
    expiresAt: input.session.expiresAt,
    revokedAt: input.session.revokedAt,
    now: input.now
  });
}

export function evaluateAgentHostUsability(input: {
  host: AgentHostIdentity;
  workspaceId: string;
  now: Date;
}): IdentityCredentialUsability {
  return evaluateCredentialUsability({
    workspaceId: input.host.workspaceId,
    expectedWorkspaceId: input.workspaceId,
    expiresAt: input.host.credentialExpiresAt,
    revokedAt: input.host.revokedAt,
    now: input.now
  });
}

/** Explicitly validates a relationship assembled from separate rows before authorization. */
export function assertWorkspaceIdentityScope(input: {
  workspace: WorkspaceScopeRef;
  principal: WorkspaceScopeRef;
  membership?: WorkspaceScopeRef;
  deviceSession?: WorkspaceScopeRef;
  operatorSession?: WorkspaceScopeRef;
  host?: WorkspaceScopeRef;
  project?: WorkspaceScopeRef;
}): void {
  const references = [
    input.principal,
    input.membership,
    input.deviceSession,
    input.operatorSession,
    input.host,
    input.project
  ].filter((value): value is WorkspaceScopeRef => value !== undefined);
  if (references.some((reference) => reference.workspaceId !== input.workspace.workspaceId)) {
    throw new Error("cross_workspace_reference");
  }
}

// Intent-revealing aliases used by Server, Desktop, and Agent Host consumers.
export const workspacePrincipalSchema = humanPrincipalSchema;
export const humanMembershipSchema = workspaceMembershipSchema;
export const humanDeviceSessionSchema = deviceSessionSchema;
export const hostIdentitySchema = agentHostIdentitySchema;
export const hostEnrollmentGrantSchema = agentHostEnrollmentSchema;
