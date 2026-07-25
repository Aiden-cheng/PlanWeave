import { humanBootstrapResponseSchema, humanMemberPageSchema } from "../identity.js";
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
import { parseCollaborationConnectionProfile } from "../connection.js";
import {
  humanObserverCatchupRequiredSchema,
  humanObserverEventSchema,
  humanObserverWelcomeSchema
} from "../observer.js";
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
