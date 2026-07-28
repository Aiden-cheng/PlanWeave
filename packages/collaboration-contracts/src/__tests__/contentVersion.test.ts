import { describe, expect, it } from "vitest";
import {
  authorizedContentVersionAcknowledgementSchema,
  authorizedContentVersionFetchSchema,
  authoritativeContentHeadSchema,
  canonicalContentVersionDigestPayload,
  completeContentVersionSchema,
  contentReplicaStatusSchema,
  contentVersionDesktopReadModelSchema,
  contentVersionJournalEntrySchema,
  contentVersionMaterializeResultSchema,
  firstContentVersionPublishRequestSchema,
  firstContentVersionPublishResultSchema,
  ownerAuthorizedFirstContentVersionPublishSchema
} from "../contentVersion.js";
import {
  exampleAuthoritativeContentVersion,
  exampleCompleteContentVersion,
  exampleContentVersionCanonicalPayload
} from "../fixtures/contentVersion.js";

const scope = exampleAuthoritativeContentVersion.scope;
const content = exampleAuthoritativeContentVersion.completed;
const head = {
  schemaVersion: "content-version/v1" as const,
  scope,
  revision: 1,
  content,
  advancedAt: "2030-01-01T00:00:01.000Z"
};

describe("authoritative content-version contracts", () => {
  it("requires a bounded canonical manifest, every prompt member, and desktop layout", () => {
    expect(exampleCompleteContentVersion.members).toHaveLength(4);
    expect(canonicalContentVersionDigestPayload(exampleCompleteContentVersion)).toBe(
      exampleContentVersionCanonicalPayload
    );
    expect(() =>
      completeContentVersionSchema.parse({
        ...exampleCompleteContentVersion,
        members: [...exampleCompleteContentVersion.members].reverse()
      })
    ).toThrow();
    expect(() =>
      completeContentVersionSchema.parse({
        ...exampleCompleteContentVersion,
        members: exampleCompleteContentVersion.members.filter(
          (member) => member.kind !== "desktop_layout"
        )
      })
    ).toThrow();
  });

  it("rejects arbitrary paths, invalid member kinds, and unverified byte metadata", () => {
    const [layout] = exampleCompleteContentVersion.members;
    expect(layout).toBeDefined();
    expect(() =>
      completeContentVersionSchema.parse({
        ...exampleCompleteContentVersion,
        members: [
          { ...layout!, path: "../../desktop/layout.json" },
          ...exampleCompleteContentVersion.members.slice(1)
        ]
      })
    ).toThrow();
    expect(() =>
      completeContentVersionSchema.parse({
        ...exampleCompleteContentVersion,
        members: [
          { ...layout!, kind: "manifest" },
          ...exampleCompleteContentVersion.members.slice(1)
        ]
      })
    ).toThrow();
    expect(() =>
      completeContentVersionSchema.parse({
        ...exampleCompleteContentVersion,
        members: [
          { ...layout!, sizeBytes: 1 },
          ...exampleCompleteContentVersion.members.slice(1)
        ],
        totalBytes: 18
      })
    ).toThrow();
  });

  it("accepts only owner-authorized empty-head CAS publication", () => {
    const request = firstContentVersionPublishRequestSchema.parse({
      projectId: scope.projectId,
      canvasId: scope.canvasId,
      expectedHeadRevision: 0,
      expectedHeadVersionId: null,
      content: exampleCompleteContentVersion
    });
    expect(
      ownerAuthorizedFirstContentVersionPublishSchema.parse({
        request,
        scope,
        owner: "human-owner-001",
        actor: { kind: "human", id: "human-owner-001" },
        deviceSessionId: "device-session-001",
        aclRevision: 1
      }).request.expectedHeadRevision
    ).toBe(0);
    expect(() =>
      ownerAuthorizedFirstContentVersionPublishSchema.parse({
        request,
        scope,
        owner: "human-owner-001",
        actor: { kind: "human", id: "human-member-002" },
        deviceSessionId: "device-session-001",
        aclRevision: 1
      })
    ).toThrow();
    expect(() =>
      firstContentVersionPublishRequestSchema.parse({ ...request, expectedHeadRevision: 1 })
    ).toThrow();
  });

  it("makes failed first-head verification headless and retryable with an explicit reason", () => {
    expect(
      firstContentVersionPublishResultSchema.parse({
        outcome: "rejected",
        reason: "content_verification_failed",
        retryable: true,
        detail: "canonical digest verification failed",
        head: null
      }).outcome
    ).toBe("rejected");
    expect(() =>
      firstContentVersionPublishResultSchema.parse({
        outcome: "rejected",
        reason: "head_cas_conflict",
        retryable: true,
        detail: "head changed",
        head
      })
    ).toThrow();
  });

  it("binds immutable completed versions to heads and contiguous journal entries", () => {
    expect(authoritativeContentHeadSchema.parse(head).content.versionId).toBe(content.versionId);
    expect(
      contentVersionJournalEntrySchema.parse({
        schemaVersion: "content-version/v1",
        scope,
        revision: 1,
        previousRevision: 0,
        content,
        acceptedAt: "2030-01-01T00:00:01.000Z"
      }).content.canonicalDigest
    ).toBe(content.canonicalDigest);
    expect(() =>
      contentVersionJournalEntrySchema.parse({
        schemaVersion: "content-version/v1",
        scope,
        revision: 2,
        previousRevision: 0,
        content,
        acceptedAt: "2030-01-01T00:00:01.000Z"
      })
    ).toThrow();
    expect(() =>
      authoritativeContentHeadSchema.parse({ ...head, content: { ...content, verification: "pending" } })
    ).toThrow();
  });

  it("allows fetch only through a matching authorized scope and device", () => {
    const request = { projectId: scope.projectId, canvasId: scope.canvasId, content };
    expect(
      authorizedContentVersionFetchSchema.parse({
        request,
        scope,
        deviceSessionId: "device-session-002",
        aclRevision: 2
      }).request.content.versionId
    ).toBe(content.versionId);
    expect(() =>
      authorizedContentVersionFetchSchema.parse({
        request: { ...request, canvasId: "canvas-other" },
        scope,
        deviceSessionId: "device-session-002",
        aclRevision: 2
      })
    ).toThrow();
  });

  it("rejects stale or cross-version acknowledgement replay", () => {
    const acknowledgement = {
      scope,
      deviceSessionId: "device-session-002",
      content,
      acknowledgedAt: "2030-01-01T00:01:00.000Z"
    };
    expect(
      authorizedContentVersionAcknowledgementSchema.parse({
        request: { content },
        acknowledgement
      }).acknowledgement.deviceSessionId
    ).toBe("device-session-002");
    expect(() =>
      authorizedContentVersionAcknowledgementSchema.parse({
        request: { content },
        acknowledgement: {
          ...acknowledgement,
          content: { ...content, canonicalDigest: "f".repeat(64), versionId: `version-${"f".repeat(64)}` }
        }
      })
    ).toThrow();
  });

  it("requires explicit materialization failure reasons", () => {
    expect(
      contentVersionMaterializeResultSchema.parse({
        outcome: "materialized",
        content,
        retryable: false,
        reason: null
      }).outcome
    ).toBe("materialized");
    expect(() =>
      contentVersionMaterializeResultSchema.parse({
        outcome: "retry_required",
        content,
        retryable: true,
        reason: null
      })
    ).toThrow();
  });

  it("permits exactly the four replica states and keeps recovery fail closed", () => {
    expect(contentReplicaStatusSchema.options).toEqual([
      "in_sync",
      "behind",
      "diverged",
      "snapshot_required"
    ]);
    expect(
      contentVersionDesktopReadModelSchema.parse({
        authoritativeHead: head,
        localReplica: content,
        replicaStatus: "in_sync",
        lastAcknowledgement: null,
        canPublishInitial: false,
        canMaterialize: true,
        canRecover: true,
        offlineWriteReason: null
      }).replicaStatus
    ).toBe("in_sync");
    expect(() =>
      contentVersionDesktopReadModelSchema.parse({
        authoritativeHead: head,
        localReplica: null,
        replicaStatus: "snapshot_required",
        lastAcknowledgement: null,
        canPublishInitial: false,
        canMaterialize: true,
        canRecover: false,
        offlineWriteReason: "shared offline mode is read-only"
      })
    ).toThrow();
    expect(() => contentReplicaStatusSchema.parse("offline")).toThrow();
  });
});
