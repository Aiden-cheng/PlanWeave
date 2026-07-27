import {
  agentHostEnrollmentSchema,
  agentHostIdentitySchema,
  agentHostIdentityViewSchema,
  deviceSessionSchema,
  humanBootstrapResponseSchema,
  humanPrincipalSchema,
  operatorSessionSchema,
  workspaceIdentityViewSchema,
  workspaceHumanPrincipalViewSchema,
  workspaceMembershipSchema,
  workspaceMembershipViewSchema,
  workspaceSchema,
  humanMemberPageSchema
} from "../identity.js";
import {
  identityMigrationMatrixSchema,
  identityMigrationStateSchema,
  legacyProjectWorkspaceMappingSchema
} from "../migration.js";
import {
  assignmentDisplayProjectionSchema,
  assignmentUpdateWireCommandSchema
} from "../assignment.js";
import {
  activityListPageSchema,
  activityRecordSchema,
  commentDisplayProjectionSchema,
  commentListPageSchema
} from "../comments.js";
import {
  parseCollaborationConnectionProfile,
  parseWorkspaceConnectionProfile
} from "../connection.js";
import {
  humanObserverCatchupRequiredSchema,
  humanObserverEventSchema,
  humanObserverWelcomeSchema
} from "../observer.js";
import { canvasAccessRecordSchema, projectAccessRecordSchema } from "../projectAccess.js";
import { packageSnapshotSchema } from "../packageSnapshot.js";
import { humanDeviceTokenSchema, projectInvitationTokenSchema } from "../primitives.js";

/** Deterministic 43-char base64url secret segment (test-only; not a real secret). */
const SECRET_SEGMENT = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export const exampleHumanDeviceToken = humanDeviceTokenSchema.parse(`pw_hdev_${SECRET_SEGMENT}`);
export const exampleInvitationToken = projectInvitationTokenSchema.parse(
  `pw_inv_${SECRET_SEGMENT}`
);

export const exampleConnectionProfile = parseCollaborationConnectionProfile({
  profileId: "profile-demo-001",
  displayName: "Local collab server",
  serverBaseUrl: "https://collab.example.com/",
  projectId: "project-demo-001",
  allowInsecureTransport: false
});

export const exampleLoopbackConnectionProfile = parseCollaborationConnectionProfile({
  profileId: "profile-loopback-001",
  displayName: "Loopback",
  serverBaseUrl: "http://127.0.0.1:8787/",
  projectId: "project-demo-001",
  allowInsecureTransport: true
});

export const exampleWorkspaceConnectionProfile = parseWorkspaceConnectionProfile({
  schemaVersion: "workspace-identity/v1",
  profileId: "profile-workspace-001",
  displayName: "Workspace collaboration server",
  serverBaseUrl: "https://collab.example.com/",
  workspaceId: "workspace-demo-001",
  allowInsecureTransport: false
});

export const exampleWorkspace = workspaceSchema.parse({
  schemaVersion: "workspace-identity/v1",
  workspaceId: "workspace-demo-001",
  displayName: "PlanWeave Demo",
  createdAt: "2030-01-01T00:00:00.000Z",
  archivedAt: null
});

export const exampleProjectAccessRecord = projectAccessRecordSchema.parse({
  schemaVersion: "project-access/v1",
  registry: {
    projectRegistryId: "registry-project-demo-001",
    workspaceId: "workspace-demo-001",
    projectId: "project-demo-001"
  },
  visibility: "private",
  acl: { revision: 1, updatedAt: "2030-01-01T00:00:00.000Z" },
  owner: "human-owner-001",
  updatedAt: "2030-01-01T00:00:00.000Z"
});

export const exampleCanvasAccessRecord = canvasAccessRecordSchema.parse({
  schemaVersion: "project-access/v1",
  registry: {
    projectRegistryId: "registry-project-demo-001",
    canvasRegistryId: "registry-canvas-demo-001",
    workspaceId: "workspace-demo-001",
    projectId: "project-demo-001",
    canvasId: "canvas-default"
  },
  visibility: "shared",
  acl: { revision: 2, updatedAt: "2030-01-01T00:00:00.000Z" },
  owner: "human-owner-001",
  updatedAt: "2030-01-01T00:00:00.000Z"
});

export const examplePackageSnapshot = packageSnapshotSchema.parse({
  schemaVersion: "package-snapshot/v1",
  immutable: {
    snapshotId: "snapshot-demo-001",
    registry: {
      projectRegistryId: "registry-project-demo-001",
      canvasRegistryId: "registry-canvas-demo-001",
      workspaceId: "workspace-demo-001",
      projectId: "project-demo-001",
      canvasId: "canvas-default"
    },
    sourceRevision: "git:demo-revision",
    createdAt: "2030-01-01T00:00:00.000Z",
    creator: { kind: "human", id: "human-owner-001", displayName: "Owner" },
    digestManifest: {
      manifest: { digestSha256: "a".repeat(64), sizeBytes: 128 },
      prompts: [],
      totalBytes: 128
    },
    migrationMarker: "digest_verified"
  },
  mutable: {
    state: "available",
    aclRevision: 2,
    visibility: { project: "private", canvas: "shared" },
    updatedAt: "2030-01-01T00:00:00.000Z",
    revokedAt: null,
    retentionOrder: 1,
    restoreMarker: "none"
  }
});

export const exampleWorkspacePrincipal = humanPrincipalSchema.parse({
  schemaVersion: "workspace-identity/v1",
  workspaceId: "workspace-demo-001",
  humanPrincipalId: "human-owner-001",
  displayName: "Owner",
  createdAt: "2030-01-01T00:00:00.000Z",
  revokedAt: null
});

export const exampleWorkspaceMembership = workspaceMembershipSchema.parse({
  schemaVersion: "workspace-identity/v1",
  workspaceId: "workspace-demo-001",
  membershipId: "membership-workspace-001",
  humanPrincipalId: "human-owner-001",
  role: "owner",
  revision: 1,
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:00.000Z",
  revokedAt: null
});

export const exampleDeviceSession = deviceSessionSchema.parse({
  schemaVersion: "workspace-identity/v1",
  workspaceId: "workspace-demo-001",
  deviceSessionId: "device-session-001",
  humanPrincipalId: "human-owner-001",
  credentialSha256: "a".repeat(64),
  issuedAt: "2030-01-01T00:00:00.000Z",
  expiresAt: "2030-01-02T00:00:00.000Z",
  revokedAt: null,
  lastUsedAt: null
});

export const exampleOperatorSession = operatorSessionSchema.parse({
  schemaVersion: "workspace-identity/v1",
  workspaceId: "workspace-demo-001",
  operatorSessionId: "operator-session-001",
  operatorId: "operator-001",
  credentialSha256: "b".repeat(64),
  issuedAt: "2030-01-01T00:00:00.000Z",
  expiresAt: "2030-01-02T00:00:00.000Z",
  revokedAt: null
});

export const exampleAgentHostIdentity = agentHostIdentitySchema.parse({
  schemaVersion: "workspace-identity/v1",
  workspaceId: "workspace-demo-001",
  hostId: "host-001",
  displayName: "Build Host",
  capabilities: ["acp.codex", "workspace.git"],
  capacity: 2,
  credentialSha256: "c".repeat(64),
  createdAt: "2030-01-01T00:00:00.000Z",
  lastSeenAt: "2030-01-01T00:01:00.000Z",
  credentialExpiresAt: "2030-01-02T00:00:00.000Z",
  revokedAt: null
});

export const exampleAgentHostEnrollment = agentHostEnrollmentSchema.parse({
  schemaVersion: "workspace-identity/v1",
  workspaceId: "workspace-demo-001",
  enrollmentId: "enrollment-001",
  enrollmentCodeSha256: "d".repeat(64),
  credentialExpiresAt: "2030-01-03T00:00:00.000Z",
  expiresAt: "2030-01-02T00:00:00.000Z",
  usedAt: null,
  hostId: null,
  revokedAt: null,
  createdAt: "2030-01-01T00:00:00.000Z"
});

export const exampleIdentityMigrationState = identityMigrationStateSchema.parse({
  schemaVersion: "workspace-identity-migration/v1",
  migrationId: "migration-001",
  legacyProjectId: "project-demo-001",
  workspaceId: "workspace-demo-001",
  fromVersion: 0,
  toVersion: 1,
  step: "map_legacy_project",
  status: "in_progress",
  interruptionMarker: "mapping_written",
  authoritativeReadVersion: "workspace-identity/v1",
  failureCode: null,
  updatedAt: "2030-01-01T00:01:00.000Z"
});

export const exampleLegacyProjectWorkspaceMapping = legacyProjectWorkspaceMappingSchema.parse({
  schemaVersion: "workspace-identity-migration/v1",
  mappingVersion: "legacy-project-workspace/v1",
  legacyProjectId: "project-demo-001",
  normalizedLegacyProjectIdentity: "legacy-project:project-demo-001",
  workspaceId: "workspace-demo-001",
  mappedAt: "2030-01-01T00:00:00.000Z"
});

export const exampleIdentityMigrationMatrix = identityMigrationMatrixSchema.parse({
  schemaVersion: "workspace-identity-migration/v1",
  migrationVersion: 1,
  readCutoverVersion: "workspace-identity/v1",
  entries: [
    {
      legacyVersion: 0,
      migrationStep: "map_legacy_project",
      authoritativeReadVersion: "workspace-identity/v1",
      interruptionMarker: "mapping_written",
      retryResult: "retry_idempotent",
      repairResult: "repair_required",
      rollbackResult: "rollback_to_legacy",
      readCutover: "legacy",
      partialFailureReadPolicy: "fail_closed"
    },
    {
      legacyVersion: 1,
      migrationStep: "cutover_authoritative_reads",
      authoritativeReadVersion: "workspace-identity/v1",
      interruptionMarker: "read_cutover_complete",
      retryResult: "resume_from_marker",
      repairResult: "repair_required",
      rollbackResult: "rollback_to_legacy",
      readCutover: "workspace",
      partialFailureReadPolicy: "fail_closed"
    }
  ]
});

export const exampleIdentityMigrationStateFixtures = [
  exampleIdentityMigrationState,
  identityMigrationStateSchema.parse({
    ...exampleIdentityMigrationState,
    status: "completed",
    step: "verify_cutover",
    interruptionMarker: "read_cutover_complete",
    failureCode: null
  }),
  identityMigrationStateSchema.parse({
    ...exampleIdentityMigrationState,
    status: "interrupted",
    interruptionMarker: "partial_backfill_failed",
    failureCode: "membership_backfill_failed"
  }),
  identityMigrationStateSchema.parse({
    ...exampleIdentityMigrationState,
    status: "repair_required",
    interruptionMarker: "partial_backfill_failed",
    failureCode: "repair_required"
  }),
  identityMigrationStateSchema.parse({
    ...exampleIdentityMigrationState,
    status: "rolled_back",
    step: "verify_cutover",
    interruptionMarker: "rollback_complete",
    failureCode: null
  })
] as const;

export const exampleWorkspaceRedactedViews = {
  workspace: workspaceIdentityViewSchema.parse(exampleWorkspace),
  principal: workspaceHumanPrincipalViewSchema.parse(exampleWorkspacePrincipal),
  membership: workspaceMembershipViewSchema.parse({
    ...exampleWorkspaceMembership,
    displayName: "Owner"
  }),
  host: agentHostIdentityViewSchema.parse({
    schemaVersion: exampleAgentHostIdentity.schemaVersion,
    workspaceId: exampleAgentHostIdentity.workspaceId,
    hostId: exampleAgentHostIdentity.hostId,
    displayName: exampleAgentHostIdentity.displayName,
    capabilities: exampleAgentHostIdentity.capabilities,
    capacity: exampleAgentHostIdentity.capacity,
    lastSeenAt: exampleAgentHostIdentity.lastSeenAt,
    credentialExpiresAt: exampleAgentHostIdentity.credentialExpiresAt,
    revokedAt: exampleAgentHostIdentity.revokedAt
  })
};

export const exampleBootstrapResponse = humanBootstrapResponseSchema.parse({
  principal: {
    humanPrincipalId: "human-owner-001",
    displayName: "Owner",
    createdAt: "2030-01-01T00:00:00.000Z"
  },
  membership: {
    membershipId: "membership-001",
    projectId: "project-demo-001",
    humanPrincipalId: "human-owner-001",
    displayName: "Owner",
    role: "owner",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z"
  },
  device: {
    deviceCredentialId: "device-001",
    humanPrincipalId: "human-owner-001",
    mintedForProjectId: "project-demo-001",
    label: "Desktop",
    createdAt: "2030-01-01T00:00:00.000Z"
  },
  deviceToken: exampleHumanDeviceToken,
  created: true
});

export const exampleMemberPage = humanMemberPageSchema.parse({
  items: [
    {
      membershipId: "membership-001",
      projectId: "project-demo-001",
      humanPrincipalId: "human-owner-001",
      displayName: "Owner",
      role: "owner",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z"
    }
  ],
  nextCursor: null
});

export const exampleAssignmentProjection = assignmentDisplayProjectionSchema.parse({
  projectId: "project-demo-001",
  workItem: { kind: "task", canvasId: "canvas-1", taskId: "task-1" },
  target: { kind: "human", humanPrincipalId: "human-owner-001" },
  revision: 1,
  updatedBy: { kind: "human", id: "human-owner-001", displayName: "Owner" },
  updatedAt: "2030-01-01T00:01:00.000Z",
  human: {
    humanPrincipalId: "human-owner-001",
    displayName: "Owner",
    membershipActive: true
  },
  availability: { status: "ready", reason: "ready" }
});

export const exampleAssignmentUpdateCommand = assignmentUpdateWireCommandSchema.parse({
  workItem: { kind: "task", canvasId: "canvas-1", taskId: "task-1" },
  target: { kind: "unassigned" },
  expectedRevision: 1,
  reason: "hand back to pool"
});

export const exampleCommentProjection = commentDisplayProjectionSchema.parse({
  commentId: "comment-001",
  projectId: "project-demo-001",
  workItem: { kind: "task", canvasId: "canvas-1", taskId: "task-1" },
  author: {
    humanPrincipalId: "human-owner-001",
    displayName: "Owner",
    membershipActive: true
  },
  body: "Looks good so far.",
  bodyFormat: "markdown",
  revision: 1,
  createdAt: "2030-01-01T00:02:00.000Z",
  updatedAt: "2030-01-01T00:02:00.000Z",
  tombstoned: false,
  attachments: [],
  workItemPresence: "present"
});

export const exampleCommentListPage = commentListPageSchema.parse({
  items: [exampleCommentProjection],
  nextCursor: null
});

export const exampleActivityRecord = activityRecordSchema.parse({
  activityId: "activity-001",
  projectId: "project-demo-001",
  type: "comment_created",
  source: { kind: "comment", sourceId: "comment-001" },
  summary: {
    headline: "Owner commented on task-1",
    workItem: { kind: "task", canvasId: "canvas-1", taskId: "task-1" },
    commentId: "comment-001",
    humanPrincipalId: "human-owner-001"
  },
  subjects: [
    {
      kind: "human",
      humanPrincipalId: "human-owner-001",
      displayName: "Owner"
    }
  ],
  workItem: { kind: "task", canvasId: "canvas-1", taskId: "task-1" },
  occurredAt: "2030-01-01T00:02:00.000Z"
});

export const exampleActivityListPage = activityListPageSchema.parse({
  items: [exampleActivityRecord],
  nextCursor: null
});

export const exampleObserverWelcome = humanObserverWelcomeSchema.parse({
  type: "human.observer.welcome",
  protocolVersion: 1,
  projectId: "project-demo-001",
  serverTime: "2030-01-01T00:03:00.000Z",
  cursor: 10
});

export const exampleObserverEvent = humanObserverEventSchema.parse({
  type: "human.observer.event",
  protocolVersion: 1,
  cursor: 11,
  previousCursor: 10,
  occurredAt: "2030-01-01T00:03:01.000Z",
  kind: "assignment",
  workItem: { kind: "task", canvasId: "canvas-1", taskId: "task-1" }
});

export const exampleObserverCatchupRequired = humanObserverCatchupRequiredSchema.parse({
  type: "human.observer.catchup_required",
  protocolVersion: 1,
  reason: "retention_gap",
  resumeCursor: 100,
  droppedThroughCursor: 50
});

/** Fixtures that must never appear in redacted logs. */
export const exampleSecretsForRedaction = {
  deviceToken: exampleHumanDeviceToken,
  invitationToken: exampleInvitationToken,
  authorizationHeader: `Bearer ${exampleHumanDeviceToken}`
} as const;
