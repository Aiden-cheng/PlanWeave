import { describe, expect, it } from "vitest";
import {
  authorizeAssignmentMutation,
  decideAssignmentUpdate,
  evaluateAssignmentAvailability,
  evaluateAssignmentRevision,
  evaluateAssignmentTarget,
  evaluateDispatchAgainstAssignment,
  assignmentChangeAffectsActiveDispatch,
  hostSatisfiesCapabilities,
  projectAssignmentDisplay
} from "../work/policy.js";
import {
  assignmentUpdateCommandSchema,
  type AssignmentHostFacts,
  type AssignmentMembershipFacts,
  type WorkItemPackageFacts
} from "../work/schemas.js";

const now = new Date("2026-07-24T12:00:00.000Z");

const actor = {
  humanPrincipalId: "human-1",
  displayName: "Ada",
  deviceCredentialId: "device-1",
  projectId: "project-a",
  role: "member" as const,
  membershipId: "membership-1"
};

const blockRef = {
  kind: "block" as const,
  canvasId: "default",
  blockRef: "T-001#B-001"
};

const taskRef = {
  kind: "task" as const,
  canvasId: "default",
  taskId: "T-001"
};

function packageBlock(
  overrides: Partial<WorkItemPackageFacts> = {}
): WorkItemPackageFacts {
  return {
    canvasId: "default",
    kind: "block",
    exists: true,
    blockRef: "T-001#B-001",
    taskId: "T-001",
    blockType: "implementation",
    requiredCapabilities: ["acp.codex", "linux"],
    ...overrides
  };
}

function packageTask(): WorkItemPackageFacts {
  return {
    canvasId: "default",
    kind: "task",
    exists: true,
    taskId: "T-001",
    requiredCapabilities: []
  };
}

function membership(
  overrides: Partial<AssignmentMembershipFacts> = {}
): AssignmentMembershipFacts {
  return {
    projectId: "project-a",
    humanPrincipalId: "human-2",
    membershipActive: true,
    displayName: "Bob",
    ...overrides
  };
}

function host(overrides: Partial<AssignmentHostFacts> = {}): AssignmentHostFacts {
  return {
    projectId: "project-a",
    hostId: "host-1",
    exists: true,
    revoked: false,
    authorizedForProject: true,
    online: true,
    capabilities: ["acp.codex", "linux", "git.read"],
    displayName: "Builder",
    capacityRemaining: 1,
    ...overrides
  };
}

describe("work assignment policy", () => {
  it("authorizes assign_work for members/owners and denies unauthenticated / cross-project", () => {
    expect(
      authorizeAssignmentMutation({
        subject: { kind: "human", context: actor },
        projectId: "project-a"
      })
    ).toEqual({ allowed: true });

    expect(
      authorizeAssignmentMutation({
        subject: { kind: "human", context: { ...actor, role: "owner" } },
        projectId: "project-a"
      })
    ).toEqual({ allowed: true });

    expect(
      authorizeAssignmentMutation({
        subject: { kind: "unauthenticated" },
        projectId: "project-a"
      })
    ).toMatchObject({ allowed: false, code: "work_auth_unauthenticated" });

    expect(
      authorizeAssignmentMutation({
        subject: { kind: "human", context: actor },
        projectId: "project-b"
      })
    ).toMatchObject({ allowed: false, code: "work_auth_project_mismatch" });
  });

  it("rejects machine targets for Tasks and inactive human / invalid Host targets for Blocks", () => {
    expect(
      evaluateAssignmentTarget({
        workItem: taskRef,
        target: { kind: "exact_host", hostId: "host-1" },
        packageFacts: packageTask()
      })
    ).toMatchObject({ allowed: false, code: "work_item_kind_target_mismatch" });

    expect(
      evaluateAssignmentTarget({
        workItem: taskRef,
        target: { kind: "human", humanPrincipalId: "human-2" },
        packageFacts: packageTask(),
        membership: membership()
      })
    ).toEqual({ allowed: true });

    expect(
      evaluateAssignmentTarget({
        workItem: blockRef,
        target: { kind: "human", humanPrincipalId: "human-2" },
        packageFacts: packageBlock(),
        membership: membership({ membershipActive: false })
      })
    ).toMatchObject({ allowed: false, code: "work_human_not_member" });

    expect(
      evaluateAssignmentTarget({
        workItem: blockRef,
        target: { kind: "exact_host", hostId: "host-1" },
        packageFacts: packageBlock(),
        host: host({ authorizedForProject: false })
      })
    ).toMatchObject({ allowed: false, code: "work_host_not_authorized" });

    expect(
      evaluateAssignmentTarget({
        workItem: blockRef,
        target: { kind: "exact_host", hostId: "host-1" },
        packageFacts: packageBlock(),
        host: host({ capabilities: ["linux"] })
      })
    ).toMatchObject({ allowed: false, code: "work_host_capability_mismatch" });

    expect(
      evaluateAssignmentTarget({
        workItem: blockRef,
        target: { kind: "automatic_host" },
        packageFacts: packageBlock()
      })
    ).toEqual({ allowed: true });
  });

  it("enforces optimistic concurrency without applying arbitrary targets", () => {
    expect(
      evaluateAssignmentRevision({ expectedRevision: 0, currentRevision: 0 })
    ).toEqual({ allowed: true });
    expect(
      evaluateAssignmentRevision({ expectedRevision: 1, currentRevision: 2 })
    ).toMatchObject({ allowed: false, code: "work_revision_conflict" });

    const command = assignmentUpdateCommandSchema.parse({
      projectId: "project-a",
      workItem: blockRef,
      target: { kind: "exact_host", hostId: "host-1" },
      expectedRevision: 0,
      actor,
      reason: "pin builder"
    });

    const first = decideAssignmentUpdate({
      command,
      concurrency: { currentRevision: 0 },
      packageFacts: packageBlock(),
      host: host(),
      now
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected success");
    expect(first.record.revision).toBe(1);
    expect(first.record.target).toEqual({ kind: "exact_host", hostId: "host-1" });

    const stale = decideAssignmentUpdate({
      command: { ...command, expectedRevision: 0, target: { kind: "unassigned" } },
      concurrency: { currentRevision: 1, current: first.record },
      packageFacts: packageBlock(),
      now
    });
    expect(stale).toMatchObject({ ok: false, code: "work_revision_conflict" });

    const next = decideAssignmentUpdate({
      command: {
        ...command,
        expectedRevision: 1,
        target: { kind: "human", humanPrincipalId: "human-2" }
      },
      concurrency: { currentRevision: 1, current: first.record },
      packageFacts: packageBlock(),
      membership: membership(),
      now
    });
    expect(next.ok).toBe(true);
    if (!next.ok) throw new Error("expected success");
    expect(next.record.revision).toBe(2);
    expect(next.previousTarget).toEqual({ kind: "exact_host", hostId: "host-1" });
  });

  it("exposes invalid/unavailable readiness when member or Host disappears (no silent retarget)", () => {
    expect(
      evaluateAssignmentAvailability({
        workItem: blockRef,
        target: { kind: "human", humanPrincipalId: "human-2" },
        packageFacts: packageBlock(),
        membership: membership({ membershipActive: false })
      })
    ).toEqual({ status: "invalid", reason: "human_membership_inactive" });

    expect(
      evaluateAssignmentAvailability({
        workItem: blockRef,
        target: { kind: "exact_host", hostId: "host-1" },
        packageFacts: packageBlock(),
        host: host({ online: false })
      })
    ).toEqual({ status: "unavailable", reason: "host_offline" });

    expect(
      evaluateAssignmentAvailability({
        workItem: blockRef,
        target: { kind: "exact_host", hostId: "host-1" },
        packageFacts: packageBlock(),
        host: host({ revoked: true })
      })
    ).toEqual({ status: "invalid", reason: "host_revoked" });

    expect(
      evaluateAssignmentAvailability({
        workItem: blockRef,
        target: { kind: "automatic_host" },
        packageFacts: packageBlock()
      })
    ).toEqual({ status: "pending", reason: "automatic_pending_selection" });

    const projection = projectAssignmentDisplay({
      projectId: "project-a",
      workItem: blockRef,
      packageFacts: packageBlock(),
      membership: membership({ membershipActive: false }),
      record: {
        projectId: "project-a",
        workItem: blockRef,
        target: { kind: "human", humanPrincipalId: "human-2" },
        revision: 4,
        updatedBy: { kind: "human", id: "human-1", displayName: "Ada" },
        updatedAt: "2026-07-24T11:00:00.000Z"
      }
    });
    expect(projection.target).toEqual({ kind: "human", humanPrincipalId: "human-2" });
    expect(projection.availability).toEqual({
      status: "invalid",
      reason: "human_membership_inactive"
    });
    expect(projection.revision).toBe(4);
  });

  it("keeps assignment vs dispatch separate with an explicit decision table", () => {
    expect(
      evaluateDispatchAgainstAssignment({
        workItem: blockRef,
        packageFacts: packageBlock(),
        target: { kind: "unassigned" }
      })
    ).toMatchObject({ allowed: false, code: "work_not_agent_assigned" });

    expect(
      evaluateDispatchAgainstAssignment({
        workItem: blockRef,
        packageFacts: packageBlock(),
        target: { kind: "human", humanPrincipalId: "human-2" }
      })
    ).toMatchObject({ allowed: false, code: "work_not_agent_assigned" });

    expect(
      evaluateDispatchAgainstAssignment({
        workItem: blockRef,
        packageFacts: packageBlock(),
        target: { kind: "exact_host", hostId: "host-1" },
        requestedHostId: "host-2"
      })
    ).toMatchObject({ allowed: false, code: "work_dispatch_host_mismatch" });

    expect(
      evaluateDispatchAgainstAssignment({
        workItem: blockRef,
        packageFacts: packageBlock(),
        target: { kind: "exact_host", hostId: "host-1" }
      })
    ).toEqual({
      allowed: true,
      selection: "exact",
      exactHostId: "host-1",
      requiredCapabilities: ["acp.codex", "linux"]
    });

    expect(
      evaluateDispatchAgainstAssignment({
        workItem: blockRef,
        packageFacts: packageBlock(),
        target: { kind: "automatic_host" }
      })
    ).toEqual({
      allowed: true,
      selection: "automatic",
      requiredCapabilities: ["acp.codex", "linux"]
    });

    expect(
      evaluateDispatchAgainstAssignment({
        workItem: blockRef,
        packageFacts: packageBlock(),
        target: { kind: "unassigned" },
        allowHumanOverride: true,
        requestedHostId: "host-9"
      })
    ).toMatchObject({
      allowed: true,
      selection: "override",
      exactHostId: "host-9"
    });

    expect(
      evaluateDispatchAgainstAssignment({
        workItem: taskRef,
        packageFacts: packageTask(),
        target: { kind: "human", humanPrincipalId: "human-2" }
      })
    ).toMatchObject({ allowed: false, code: "work_item_kind_target_mismatch" });
  });

  it("requires cancel/retry when reassignment races an active dispatch Host", () => {
    expect(
      assignmentChangeAffectsActiveDispatch({
        previousTarget: { kind: "exact_host", hostId: "host-1" },
        nextTarget: { kind: "exact_host", hostId: "host-2" },
        activeDispatchHostId: "host-1"
      })
    ).toEqual({
      reassignmentWhileDispatchActive: true,
      requiresCancelOrRetry: true,
      activeDispatchHostId: "host-1"
    });

    expect(
      assignmentChangeAffectsActiveDispatch({
        previousTarget: { kind: "exact_host", hostId: "host-1" },
        nextTarget: { kind: "exact_host", hostId: "host-1" },
        activeDispatchHostId: "host-1"
      })
    ).toEqual({
      reassignmentWhileDispatchActive: false,
      requiresCancelOrRetry: false,
      activeDispatchHostId: "host-1"
    });
  });

  it("matches Host capabilities strictly against package requirements", () => {
    expect(hostSatisfiesCapabilities(["a", "b"], ["a"])).toBe(true);
    expect(hostSatisfiesCapabilities(["a"], ["a", "b"])).toBe(false);
    expect(hostSatisfiesCapabilities(["a"], [])).toBe(true);
  });
});
