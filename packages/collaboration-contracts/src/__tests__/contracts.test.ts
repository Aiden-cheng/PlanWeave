import { describe, expect, it } from "vitest";
import {
  assertHumanDisplayDtoRedacted,
  collaborationBoundaryErrorKindSchema,
  exampleActivityRecord,
  exampleAssignmentProjection,
  exampleBootstrapResponse,
  exampleConnectionProfile,
  exampleHumanDeviceToken,
  exampleLoopbackConnectionProfile,
  exampleMemberPage,
  exampleObserverCatchupRequired,
  exampleObserverEvent,
  exampleObserverWelcome,
  exampleSecretsForRedaction,
  COLLABORATION_JSON_BODY_MAX_BYTES,
  humanObserverEventSchema,
  mapHttpStatusToBoundaryKind,
  parseCollaborationClientLimits,
  parseCollaborationConnectionProfile,
  parseHumanObserverServerMessage
} from "../index.js";

describe("collaboration-contracts", () => {
  it("parses explicitly enabled private-LAN HTTP and rejects public insecure HTTP", () => {
    expect(exampleConnectionProfile.projectId).toBe("project-demo-001");
    expect(exampleLoopbackConnectionProfile.allowInsecureTransport).toBe(true);
    expect(
      parseCollaborationConnectionProfile({
        profileId: "p-lan",
        displayName: "LAN",
        serverBaseUrl: "http://192.168.1.20:8787/",
        projectId: "project-1",
        allowInsecureTransport: true
      }).serverBaseUrl
    ).toBe("http://192.168.1.20:8787/");
    expect(() =>
      parseCollaborationConnectionProfile({
        profileId: "p1",
        displayName: "Bad",
        serverBaseUrl: "http://example.com/",
        projectId: "project-1",
        allowInsecureTransport: true
      })
    ).toThrow();
  });

  it("defaults the client JSON response budget to the bounded page envelope", () => {
    const limits = parseCollaborationClientLimits();
    expect(COLLABORATION_JSON_BODY_MAX_BYTES).toBe(4 * 1_024 * 1_024);
    expect(limits.jsonBodyMaxBytes).toBe(COLLABORATION_JSON_BODY_MAX_BYTES);
  });

  it("loads shared fixtures without digest fields", () => {
    assertHumanDisplayDtoRedacted(exampleBootstrapResponse);
    assertHumanDisplayDtoRedacted(exampleMemberPage);
    assertHumanDisplayDtoRedacted(exampleAssignmentProjection);
    expect(exampleActivityRecord.type).toBe("comment_created");
    expect(exampleHumanDeviceToken.startsWith("pw_hdev_")).toBe(true);
  });

  it("validates human observer messages and cursor advance", () => {
    expect(parseHumanObserverServerMessage(exampleObserverWelcome).type).toBe(
      "human.observer.welcome"
    );
    expect(parseHumanObserverServerMessage(exampleObserverEvent).type).toBe("human.observer.event");
    expect(exampleObserverCatchupRequired.reason).toBe("retention_gap");
    expect(() =>
      humanObserverEventSchema.parse({
        ...exampleObserverEvent,
        cursor: 10,
        previousCursor: 10
      })
    ).toThrow();
  });

  it("maps HTTP statuses to boundary error kinds", () => {
    expect(mapHttpStatusToBoundaryKind(401)).toBe("auth");
    expect(mapHttpStatusToBoundaryKind(409, "work_revision_conflict")).toBe("conflict");
    expect(mapHttpStatusToBoundaryKind(429)).toBe("rate_limited");
    expect(collaborationBoundaryErrorKindSchema.parse("offline")).toBe("offline");
  });

  it("exposes secrets only as explicit redaction fixtures", () => {
    expect(exampleSecretsForRedaction.deviceToken).toContain("pw_hdev_");
    expect(exampleSecretsForRedaction.authorizationHeader).toContain("Bearer ");
  });

  it("validates remote operation observation and action wire shapes", async () => {
    const {
      remoteActionViewSchema,
      remoteDispatchWireCommandSchema,
      remoteExecutionActionWireRequestSchema,
      remoteHumanExecutionActionCommandSchema,
      remoteOperationObservationSchema
    } = await import("../remoteRun.js");
    expect(
      remoteDispatchWireCommandSchema.parse({
        canvasId: "default",
        blockRef: "T-1#B-1",
        idempotencyKey: "idem-1"
      }).blockRef
    ).toBe("T-1#B-1");
    expect(
      remoteOperationObservationSchema.parse({
        operationId: "op-1",
        projectId: "project-1",
        canvasId: "default",
        blockRef: "T-1#B-1",
        state: "running",
        dispatchId: "dispatch-1",
        executionAttemptId: "attempt-1",
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-01T00:00:00.000Z",
        attempt: {
          executionAttemptId: "attempt-1",
          dispatchId: "dispatch-1",
          status: "running",
          stateVersion: 0
        },
        runtime: { ref: "T-1#B-1", status: "in_progress" }
      }).state
    ).toBe("running");
    expect(
      remoteExecutionActionWireRequestSchema.parse({
        kind: "cancel",
        actionId: "a1",
        operationId: "op-1",
        dispatchId: "dispatch-1",
        executionAttemptId: "attempt-1",
        expectedAttemptVersion: 0,
        leaseId: "lease-1",
        reason: "stop"
      }).kind
    ).toBe("cancel");
    const resumeCommand = remoteHumanExecutionActionCommandSchema.parse({
      kind: "resume_same_session",
      actionId: "resume-1",
      operationId: "op-1",
      dispatchId: "dispatch-1",
      executionAttemptId: "attempt-1",
      expectedAttemptVersion: 4,
      priorLeaseId: "lease-1",
      reason: "continue"
    });
    expect(resumeCommand).not.toHaveProperty("leaseId");
    expect(() =>
      remoteHumanExecutionActionCommandSchema.parse({
        ...resumeCommand,
        leaseId: "lease-server-generated"
      })
    ).toThrow();
    const rejectedAction = {
      request: {
        kind: "cancel",
        actionId: "a1",
        operationId: "op-1",
        dispatchId: "dispatch-1",
        executionAttemptId: "attempt-1",
        expectedAttemptVersion: 0,
        leaseId: "lease-1",
        reason: "stop"
      },
      state: "rejected",
      createdAt: "2030-01-01T00:00:00.000Z"
    } as const;
    expect(() => remoteActionViewSchema.parse(rejectedAction)).toThrow();
    expect(
      remoteActionViewSchema.parse({
        ...rejectedAction,
        rejectedAt: "2030-01-01T00:00:01.000Z",
        rejectionCode: "work_not_agent_assigned"
      }).state
    ).toBe("rejected");
  });
});
