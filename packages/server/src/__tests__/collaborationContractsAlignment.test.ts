import { describe, expect, it } from "vitest";
import {
  exampleActivityRecord,
  exampleAssignmentProjection,
  exampleBootstrapResponse,
  exampleCommentProjection,
  exampleMemberPage,
  exampleObserverEvent,
  exampleObserverWelcome,
  humanBootstrapResponseSchema as contractBootstrap,
  humanMemberPageSchema as contractMemberPage,
  assignmentDisplayProjectionSchema as contractAssignment,
  commentDisplayProjectionSchema as contractComment,
  activityRecordSchema as contractActivity,
  humanObserverEventSchema as contractObserverEvent,
  humanObserverWelcomeSchema as contractObserverWelcome
} from "@planweave-ai/collaboration-contracts";
import {
  humanBootstrapResponseSchema,
  humanMemberPageSchema
} from "../identity/dtos.js";
import { assignmentDisplayProjectionSchema } from "../work/schemas.js";
import { activityRecordSchema, commentDisplayProjectionSchema } from "../comments/schemas.js";

/**
 * Dual-parse shared fixtures against Server domain schemas and collaboration-contracts.
 * Keeps Desktop wire DTOs aligned with HC public projections without reversing deps.
 */
describe("collaboration-contracts alignment with Server", () => {
  it("parses identity fixtures with both authorities", () => {
    expect(contractBootstrap.parse(exampleBootstrapResponse).created).toBe(true);
    expect(humanBootstrapResponseSchema.parse(exampleBootstrapResponse).created).toBe(true);
    expect(contractMemberPage.parse(exampleMemberPage).items).toHaveLength(1);
    expect(humanMemberPageSchema.parse(exampleMemberPage).items).toHaveLength(1);
  });

  it("parses assignment and comment projections with both authorities", () => {
    expect(contractAssignment.parse(exampleAssignmentProjection).revision).toBe(1);
    expect(assignmentDisplayProjectionSchema.parse(exampleAssignmentProjection).revision).toBe(1);
    expect(contractComment.parse(exampleCommentProjection).tombstoned).toBe(false);
    expect(commentDisplayProjectionSchema.parse(exampleCommentProjection).tombstoned).toBe(false);
    expect(contractActivity.parse(exampleActivityRecord).type).toBe("comment_created");
    expect(activityRecordSchema.parse(exampleActivityRecord).type).toBe("comment_created");
  });

  it("parses human observer fixtures in the contracts package", () => {
    expect(contractObserverWelcome.parse(exampleObserverWelcome).cursor).toBe(10);
    expect(contractObserverEvent.parse(exampleObserverEvent).kind).toBe("assignment");
  });
});
