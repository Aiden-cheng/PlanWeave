import { describe, expect, it } from "vitest";
import {
  exampleActivityRecord,
  exampleAssignmentProjection,
  exampleBootstrapResponse,
  exampleCommentProjection,
  exampleMemberPage
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import * as protocolIdentity from "@planweave-ai/collaboration-protocol/identity/workspace";
import * as protocolAssignment from "@planweave-ai/collaboration-protocol/work/assignment";
import * as protocolPrimitives from "@planweave-ai/collaboration-protocol/core/primitives";
import * as protocolComments from "@planweave-ai/collaboration-protocol/activity/comments";
import * as serverIdentity from "../identity/dtos.js";
import * as serverWork from "../work/schemas.js";
import * as serverComments from "../comments/schemas.js";

const identitySchemaPairs = [
  [
    serverIdentity.workspaceIdentityReadModelSchema,
    protocolIdentity.workspaceIdentityReadModelSchema
  ],
  [serverIdentity.humanPrincipalViewSchema, protocolIdentity.humanPrincipalViewSchema],
  [
    serverIdentity.humanUpdateDisplayNameRequestSchema,
    protocolIdentity.humanUpdateDisplayNameRequestSchema
  ],
  [serverIdentity.humanMembershipViewSchema, protocolIdentity.humanMembershipViewSchema],
  [serverIdentity.humanDeviceViewSchema, protocolIdentity.humanDeviceViewSchema],
  [serverIdentity.humanInvitationViewSchema, protocolIdentity.humanInvitationViewSchema],
  [serverIdentity.humanMemberPageSchema, protocolIdentity.humanMemberPageSchema],
  [serverIdentity.humanDevicePageSchema, protocolIdentity.humanDevicePageSchema],
  [serverIdentity.humanInvitationPageSchema, protocolIdentity.humanInvitationPageSchema],
  [serverIdentity.humanDeviceTokenHandoffSchema, protocolIdentity.humanDeviceTokenHandoffSchema],
  [serverIdentity.humanBootstrapRequestSchema, protocolIdentity.humanBootstrapRequestSchema],
  [serverIdentity.humanBootstrapResponseSchema, protocolIdentity.humanBootstrapResponseSchema],
  [
    serverIdentity.humanCreateInvitationRequestSchema,
    protocolIdentity.humanCreateInvitationRequestSchema
  ],
  [
    serverIdentity.humanCreateInvitationResponseSchema,
    protocolIdentity.humanCreateInvitationResponseSchema
  ],
  [
    serverIdentity.humanConsumeInvitationRequestSchema,
    protocolIdentity.humanConsumeInvitationRequestSchema
  ],
  [
    serverIdentity.humanConsumeInvitationResponseSchema,
    protocolIdentity.humanConsumeInvitationResponseSchema
  ],
  [serverIdentity.humanPageQuerySchema, protocolIdentity.humanPageQuerySchema],
  [serverIdentity.humanInvitationListQuerySchema, protocolIdentity.humanInvitationListQuerySchema],
  [serverIdentity.humanDeviceListQuerySchema, protocolIdentity.humanDeviceListQuerySchema],
  [
    serverIdentity.humanRevokeInvitationsRequestSchema,
    protocolIdentity.humanRevokeInvitationsRequestSchema
  ],
  [
    serverIdentity.humanRevokeInvitationsResponseSchema,
    protocolIdentity.humanRevokeInvitationsResponseSchema
  ]
] as const;

const assignmentSchemaPairs = [
  [serverWork.assignmentTargetSchema, protocolAssignment.assignmentTargetSchema],
  [
    serverWork.assignmentAvailabilityReasonSchema,
    protocolAssignment.assignmentAvailabilityReasonSchema
  ],
  [serverWork.assignmentAvailabilitySchema, protocolAssignment.assignmentAvailabilitySchema],
  [serverWork.assignmentHumanDisplaySchema, protocolAssignment.assignmentHumanDisplaySchema],
  [serverWork.assignmentHostDisplaySchema, protocolAssignment.assignmentHostDisplaySchema],
  [
    serverWork.assignmentDisplayProjectionSchema,
    protocolAssignment.assignmentDisplayProjectionSchema
  ],
  [serverWork.assignmentMembershipFactsSchema, protocolAssignment.assignmentMembershipFactsSchema],
  [serverWork.assignmentHostFactsSchema, protocolAssignment.assignmentHostFactsSchema]
] as const;

const commentActivitySchemaPairs = [
  [serverComments.commentBodySchema, protocolComments.commentBodySchema],
  [serverComments.commentBodyFormatSchema, protocolComments.commentBodyFormatSchema],
  [
    serverComments.commentAttachmentFileNameSchema,
    protocolComments.commentAttachmentFileNameSchema
  ],
  [
    serverComments.commentAttachmentMediaTypeSchema,
    protocolComments.commentAttachmentMediaTypeSchema
  ],
  [
    serverComments.commentAttachmentSizeBytesSchema,
    protocolComments.commentAttachmentSizeBytesSchema
  ],
  [serverComments.commentAttachmentInputSchema, protocolComments.commentAttachmentInputSchema],
  [
    serverComments.commentAttachmentProjectionSchema,
    protocolComments.commentAttachmentProjectionSchema
  ],
  [serverComments.commentTombstoneReasonSchema, protocolComments.commentTombstoneReasonSchema],
  [serverComments.commentAuthorDisplaySchema, protocolComments.commentAuthorDisplaySchema],
  [serverComments.commentWorkItemPresenceSchema, protocolComments.commentWorkItemPresenceSchema],
  [serverComments.commentDisplayProjectionSchema, protocolComments.commentDisplayProjectionSchema],
  [serverComments.commentListCursorSchema, protocolComments.commentListCursorSchema],
  [serverComments.commentListPageSchema, protocolComments.commentListPageSchema],
  [serverComments.activityTypeSchema, protocolComments.activityTypeSchema],
  [serverComments.activitySourceKindSchema, protocolComments.activitySourceKindSchema],
  [serverComments.activitySourceSchema, protocolComments.activitySourceSchema],
  [serverComments.activitySubjectSchema, protocolComments.activitySubjectSchema],
  [serverComments.activitySummarySchema, protocolComments.activitySummarySchema],
  [serverComments.activityRecordSchema, protocolComments.activityRecordSchema],
  [serverComments.activityListCursorSchema, protocolComments.activityListCursorSchema],
  [serverComments.activityListPageSchema, protocolComments.activityListPageSchema]
] as const;

describe("collaboration-protocol wire schema authority", () => {
  it("re-exports every identity wire schema by instance identity", () => {
    for (const [serverSchema, protocolSchema] of identitySchemaPairs) {
      expect(serverSchema).toBe(protocolSchema);
    }

    expect(
      protocolIdentity.humanBootstrapResponseSchema.parse(exampleBootstrapResponse).created
    ).toBe(true);
    expect(protocolIdentity.humanMemberPageSchema.parse(exampleMemberPage).items).toHaveLength(1);
  });

  it("re-exports every shared assignment schema by instance identity", () => {
    expect(serverWork.workItemRefSchema).toBe(protocolPrimitives.workItemRefSchema);
    for (const [serverSchema, protocolSchema] of assignmentSchemaPairs) {
      expect(serverSchema).toBe(protocolSchema);
    }

    expect(
      protocolAssignment.assignmentDisplayProjectionSchema.parse(exampleAssignmentProjection)
        .revision
    ).toBe(1);
  });

  it("re-exports every shared comment and activity schema by instance identity", () => {
    expect(serverComments.commentIdSchema).toBe(protocolPrimitives.commentIdSchema);
    expect(serverComments.activityIdSchema).toBe(protocolPrimitives.activityIdSchema);
    expect(serverComments.pendingAttachmentUploadIdSchema).toBe(
      protocolPrimitives.pendingAttachmentUploadIdSchema
    );
    expect(serverComments.commentContentSha256Schema).toBe(
      protocolPrimitives.commentContentSha256Schema
    );
    for (const [serverSchema, protocolSchema] of commentActivitySchemaPairs) {
      expect(serverSchema).toBe(protocolSchema);
    }

    expect(
      protocolComments.commentDisplayProjectionSchema.parse(exampleCommentProjection).tombstoned
    ).toBe(false);
    expect(protocolComments.activityRecordSchema.parse(exampleActivityRecord).type).toBe(
      "comment_created"
    );
  });
});
