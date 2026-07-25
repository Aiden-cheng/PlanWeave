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
  humanObserverEventSchema,
  mapHttpStatusToBoundaryKind,
  parseCollaborationConnectionProfile,
  parseHumanObserverServerMessage
} from "../index.js";

describe("collaboration-contracts", () => {
  it("parses connection profiles and rejects non-loopback insecure HTTP", () => {
    expect(exampleConnectionProfile.projectId).toBe("project-demo-001");
    expect(exampleLoopbackConnectionProfile.allowInsecureTransport).toBe(true);
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
    expect(parseHumanObserverServerMessage(exampleObserverEvent).type).toBe(
      "human.observer.event"
    );
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
});
