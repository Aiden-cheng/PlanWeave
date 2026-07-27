import { describe, expect, it } from "vitest";
import {
  executionTargetReadModelSchema,
  executionTargetUpdateWireCommandSchema,
  hostAuthorizationDecisionSchema,
  hostAuthorizationFactsSchema,
  hostAuthorizationAttemptFactSchema,
  hostAuthorizationLeaseFactSchema,
  hostAuthorizationReadModelSchema,
  legacyAssignmentMappingSchema,
  mapLegacyAssignmentTarget,
  remoteDispatchIntentSchema,
  responsibilityUpdateWireCommandSchema,
  reviewAssignmentUpdateWireCommandSchema
} from "../index.js";

const taskScope = {
  kind: "task" as const,
  workspaceId: "workspace-1",
  projectId: "project-1",
  canvasId: "canvas-1",
  taskId: "task-1"
};
const blockScope = {
  kind: "block" as const,
  workspaceId: "workspace-1",
  projectId: "project-1",
  canvasId: "canvas-1",
  blockRef: "task-1#block-1"
};
const revisions = {
  responsibilityRevision: 2,
  reviewerRevision: 3,
  executionTargetRevision: 4
};

describe("OSS-003 collaboration authority contracts", () => {
  it("keeps responsibility and reviewer human identities independent on Task and Block scopes", () => {
    expect(
      responsibilityUpdateWireCommandSchema.parse({
        schemaVersion: "responsibility/v1",
        scope: taskScope,
        principal: { kind: "human", humanPrincipalId: "member-1" },
        expectedRevision: 0
      }).scope.kind
    ).toBe("task");
    expect(
      reviewAssignmentUpdateWireCommandSchema.parse({
        schemaVersion: "review-assignment/v1",
        scope: blockScope,
        principal: { kind: "human", humanPrincipalId: "member-2" },
        expectedRevision: 0
      }).scope.kind
    ).toBe("block");
    for (const schema of [
      responsibilityUpdateWireCommandSchema,
      reviewAssignmentUpdateWireCommandSchema
    ]) {
      expect(() =>
        schema.parse({
          schemaVersion: "responsibility/v1",
          scope: taskScope,
          principal: { kind: "operator", operatorId: "operator-1" },
          expectedRevision: 0
        })
      ).toThrow();
      expect(() =>
        schema.parse({ ...taskScope, actor: { kind: "human", id: "human-1" } })
      ).toThrow();
    }
  });

  it("accepts only exact Block Host targets and rejects human or broader scopes", () => {
    expect(
      executionTargetUpdateWireCommandSchema.parse({
        schemaVersion: "execution-target/v1",
        scope: blockScope,
        target: { kind: "exact_host", hostId: "host-1" },
        expectedRevision: 1
      }).target.kind
    ).toBe("exact_host");
    expect(
      executionTargetUpdateWireCommandSchema.parse({
        schemaVersion: "execution-target/v1",
        scope: blockScope,
        target: { kind: "automatic_host" },
        expectedRevision: 2
      }).target.kind
    ).toBe("automatic_host");
    expect(() =>
      executionTargetUpdateWireCommandSchema.parse({
        schemaVersion: "execution-target/v1",
        scope: taskScope,
        target: { kind: "exact_host", hostId: "host-1" },
        expectedRevision: 0
      })
    ).toThrow();
    expect(() =>
      executionTargetUpdateWireCommandSchema.parse({
        schemaVersion: "execution-target/v1",
        scope: blockScope,
        target: { kind: "human", humanPrincipalId: "member-1" },
        expectedRevision: 0
      })
    ).toThrow();
    expect(() =>
      executionTargetReadModelSchema.parse({
        schemaVersion: "execution-target/v1",
        scope: { ...blockScope, kind: "canvas" },
        target: { kind: "unassigned" },
        revision: 0,
        updatedAt: "2030-01-01T00:00:00.000Z",
        availability: { status: "unassigned", reason: "unassigned" }
      })
    ).toThrow();
  });

  it("keeps Host authorization facts and decisions safe and revision-aware", () => {
    const facts = hostAuthorizationFactsSchema.parse({
      schemaVersion: "host-authorization/v1",
      scope: blockScope,
      hostId: "host-1",
      hostWorkspaceId: "workspace-1",
      workspaceAcl: { revision: 5, allowed: true },
      projectAcl: { revision: 6, allowed: true },
      canvasAcl: { revision: 7, allowed: true },
      requiredCapabilities: ["linux", "node"],
      advertisedCapabilities: ["linux", "node", "git"],
      revoked: false,
      online: true,
      capacityRemaining: 1,
      lease: { status: "none", leaseId: null, expiresAt: null },
      attempt: { status: "none", dispatchId: null, executionAttemptId: null },
      expectedRevisions: revisions,
      currentRevisions: revisions,
      evaluatedAt: "2030-01-01T00:00:00.000Z"
    });
    expect(facts.currentRevisions.executionTargetRevision).toBe(4);
    expect(
      hostAuthorizationDecisionSchema.parse({
        schemaVersion: "host-authorization/v1",
        decision: "deny",
        scope: blockScope,
        hostId: "host-1",
        hostWorkspaceId: "workspace-1",
        reason: "capability_mismatch",
        currentRevisions: revisions,
        evaluatedAt: "2030-01-01T00:00:00.000Z",
        facts: {
          ...facts,
          advertisedCapabilities: ["linux"]
        }
      }).reason
    ).toBe("capability_mismatch");
    expect(() =>
      hostAuthorizationFactsSchema.parse({ ...facts, hostWorkspaceId: "workspace-2" })
    ).toThrow();
    expect(() =>
      hostAuthorizationReadModelSchema.parse({
        schemaVersion: "host-authorization/v1",
        scope: blockScope,
        hostId: "host-1",
        decision: "deny",
        reason: "host_revoked",
        currentRevisions: revisions,
        evaluatedAt: "2030-01-01T00:00:00.000Z",
        token: "pw_host_secret"
      })
    ).toThrow();
    expect(() =>
      hostAuthorizationLeaseFactSchema.parse({
        status: "active",
        leaseId: "lease-1",
        expiresAt: null
      })
    ).toThrow();
    expect(() =>
      hostAuthorizationLeaseFactSchema.parse({ status: "expired", leaseId: null, expiresAt: null })
    ).toThrow();
    expect(() =>
      hostAuthorizationAttemptFactSchema.parse({
        status: "running",
        dispatchId: "dispatch-1",
        executionAttemptId: null
      })
    ).toThrow();
    const activeFacts = {
      ...facts,
      lease: {
        status: "active" as const,
        leaseId: "lease-1",
        expiresAt: "2030-01-02T00:00:00.000Z"
      },
      attempt: {
        status: "running" as const,
        dispatchId: "dispatch-1",
        executionAttemptId: "attempt-1"
      }
    };
    expect(() =>
      hostAuthorizationDecisionSchema.parse({
        schemaVersion: "host-authorization/v1",
        decision: "allow",
        scope: blockScope,
        hostId: "host-1",
        hostWorkspaceId: "workspace-1",
        reason: "authorized",
        currentRevisions: revisions,
        evaluatedAt: "2030-01-01T00:00:00.000Z"
      })
    ).toThrow();
    expect(() =>
      hostAuthorizationDecisionSchema.parse({
        schemaVersion: "host-authorization/v1",
        decision: "allow",
        scope: blockScope,
        hostId: "host-1",
        hostWorkspaceId: "workspace-1",
        reason: "authorized",
        currentRevisions: revisions,
        evaluatedAt: "2030-01-01T00:00:00.000Z",
        facts: {
          ...activeFacts,
          expectedRevisions: { ...revisions, reviewerRevision: 1 }
        }
      })
    ).toThrow();
    expect(() =>
      hostAuthorizationDecisionSchema.parse({
        schemaVersion: "host-authorization/v1",
        decision: "allow",
        scope: blockScope,
        hostId: "host-1",
        hostWorkspaceId: "workspace-1",
        reason: "authorized",
        currentRevisions: { ...revisions, executionTargetRevision: 99 },
        evaluatedAt: "2030-01-01T00:00:00.000Z",
        facts: activeFacts
      })
    ).toThrow();
  });

  it("binds remote dispatch to exact Block and three independent revisions", () => {
    const command = remoteDispatchIntentSchema.parse({
      schemaVersion: "remote-run/v2",
      projectId: blockScope.projectId,
      canvasId: blockScope.canvasId,
      blockRef: blockScope.blockRef,
      idempotencyKey: "dispatch-1",
      expectedResponsibilityRevision: 2,
      expectedReviewerRevision: null,
      expectedExecutionTargetRevision: 4
    });
    expect(command.blockRef).toBe(blockScope.blockRef);
    expect(() =>
      remoteDispatchIntentSchema.parse({ ...command, actor: { kind: "human", id: "h" } })
    ).toThrow();
    expect(() => remoteDispatchIntentSchema.parse({ ...command, taskId: "task-1" })).toThrow();
  });

  it("requires explicit, domain-preserving legacy assignment migration", () => {
    const human = mapLegacyAssignmentTarget({
      schemaVersion: "assignment-migration/v1",
      marker: "legacy_target_requires_explicit_mapping",
      workspaceId: "workspace-1",
      projectId: "project-1",
      workItem: blockScope,
      target: { kind: "human", humanPrincipalId: "member-1" }
    });
    expect(human.mappedKind).toBe("responsibility");
    const host = mapLegacyAssignmentTarget({
      schemaVersion: "assignment-migration/v1",
      marker: "legacy_target_requires_explicit_mapping",
      workspaceId: "workspace-1",
      projectId: "project-1",
      workItem: blockScope,
      target: { kind: "exact_host", hostId: "host-1" }
    });
    expect(host.mappedKind).toBe("execution_target");
    expect(() =>
      legacyAssignmentMappingSchema.parse({
        schemaVersion: "assignment-migration/v1",
        source: "legacy_assignment_target",
        projectId: "project-1",
        scope: blockScope,
        mappedKind: "execution_target",
        marker: "host_mapped_to_execution_target",
        target: { kind: "human", humanPrincipalId: "member-1" }
      })
    ).toThrow();
  });
});
