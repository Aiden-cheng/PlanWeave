import { describe, expect, it } from "vitest";
import {
  assignmentAvailabilitySchema,
  assignmentConcurrencyFactsSchema,
  assignmentDisplayProjectionSchema,
  assignmentRecordSchema,
  assignmentTargetSchema,
  assignmentUpdateCommandSchema,
  isMachineAssignmentTarget,
  workItemRefSchema
} from "../work/schemas.js";

const actor = {
  humanPrincipalId: "human-1",
  displayName: "Ada",
  deviceCredentialId: "device-1",
  projectId: "project-a",
  role: "member" as const,
  membershipId: "membership-1"
};

const taskRef = {
  kind: "task" as const,
  canvasId: "default",
  taskId: "T-001"
};

const blockRef = {
  kind: "block" as const,
  canvasId: "default",
  blockRef: "T-001#B-001"
};

describe("work assignment schemas", () => {
  it("accepts strict WorkItemRef task and block forms and rejects free-form paths", () => {
    expect(workItemRefSchema.parse(taskRef)).toEqual(taskRef);
    expect(workItemRefSchema.parse(blockRef)).toEqual(blockRef);
    expect(() =>
      workItemRefSchema.parse({ kind: "block", canvasId: "default", blockRef: "not-a-ref" })
    ).toThrow();
    expect(() =>
      workItemRefSchema.parse({
        kind: "task",
        canvasId: "default",
        taskId: "../escape"
      })
    ).toThrow();
    expect(() =>
      workItemRefSchema.parse({
        kind: "task",
        canvasId: "default",
        taskId: "T-001",
        assignee: "someone"
      })
    ).toThrow();
  });

  it("rejects generic assignee strings and nullable target combinations", () => {
    expect(assignmentTargetSchema.parse({ kind: "unassigned" })).toEqual({ kind: "unassigned" });
    expect(
      assignmentTargetSchema.parse({ kind: "human", humanPrincipalId: "human-1" })
    ).toEqual({ kind: "human", humanPrincipalId: "human-1" });
    expect(assignmentTargetSchema.parse({ kind: "exact_host", hostId: "host-1" })).toEqual({
      kind: "exact_host",
      hostId: "host-1"
    });
    expect(assignmentTargetSchema.parse({ kind: "automatic_host" })).toEqual({
      kind: "automatic_host"
    });

    expect(() => assignmentTargetSchema.parse({ kind: "human" })).toThrow();
    expect(() => assignmentTargetSchema.parse({ kind: "exact_host" })).toThrow();
    expect(() =>
      assignmentTargetSchema.parse({
        kind: "automatic_host",
        requiredCapabilities: ["linux"]
      })
    ).toThrow();
    expect(() => assignmentTargetSchema.parse({ assignee: "ada" })).toThrow();
    expect(() =>
      assignmentTargetSchema.parse({
        kind: "human",
        humanPrincipalId: "human-1",
        hostId: "host-1"
      })
    ).toThrow();

    expect(isMachineAssignmentTarget({ kind: "exact_host", hostId: "h" })).toBe(true);
    expect(isMachineAssignmentTarget({ kind: "automatic_host" })).toBe(true);
    expect(isMachineAssignmentTarget({ kind: "human", humanPrincipalId: "h" })).toBe(false);
  });

  it("rejects Host targets on Task assignment records and commands", () => {
    expect(() =>
      assignmentRecordSchema.parse({
        projectId: "project-a",
        workItem: taskRef,
        target: { kind: "exact_host", hostId: "host-1" },
        revision: 1,
        updatedBy: { kind: "human", id: "human-1", displayName: "Ada" },
        updatedAt: "2026-07-24T12:00:00.000Z"
      })
    ).toThrow();

    expect(() =>
      assignmentRecordSchema.parse({
        projectId: "project-a",
        workItem: taskRef,
        target: { kind: "automatic_host" },
        revision: 1,
        updatedBy: { kind: "human", id: "human-1" },
        updatedAt: "2026-07-24T12:00:00.000Z"
      })
    ).toThrow();

    expect(
      assignmentRecordSchema.parse({
        projectId: "project-a",
        workItem: taskRef,
        target: { kind: "human", humanPrincipalId: "human-1" },
        revision: 1,
        updatedBy: { kind: "human", id: "human-1", displayName: "Ada" },
        updatedAt: "2026-07-24T12:00:00.000Z"
      }).target.kind
    ).toBe("human");

    expect(() =>
      assignmentUpdateCommandSchema.parse({
        projectId: "project-a",
        workItem: taskRef,
        target: { kind: "exact_host", hostId: "host-1" },
        expectedRevision: 0,
        actor
      })
    ).toThrow();

    expect(
      assignmentUpdateCommandSchema.parse({
        projectId: "project-a",
        workItem: blockRef,
        target: { kind: "automatic_host" },
        expectedRevision: 0,
        actor,
        reason: "route to fleet"
      }).target.kind
    ).toBe("automatic_host");
  });

  it("rejects actor project mismatch and capability copies on automatic targets", () => {
    expect(() =>
      assignmentUpdateCommandSchema.parse({
        projectId: "project-a",
        workItem: blockRef,
        target: { kind: "human", humanPrincipalId: "human-1" },
        expectedRevision: 0,
        actor: { ...actor, projectId: "project-b" }
      })
    ).toThrow();

    expect(() =>
      assignmentRecordSchema.parse({
        projectId: "project-a",
        workItem: blockRef,
        target: { kind: "automatic_host", capabilities: ["linux"] },
        revision: 1,
        updatedBy: { kind: "human", id: "human-1" },
        updatedAt: "2026-07-24T12:00:00.000Z"
      })
    ).toThrow();
  });

  it("models availability as a discriminated union without masking stale readiness", () => {
    expect(
      assignmentAvailabilitySchema.parse({ status: "ready", reason: "ready" }).status
    ).toBe("ready");
    expect(
      assignmentAvailabilitySchema.parse({
        status: "invalid",
        reason: "human_membership_inactive"
      }).status
    ).toBe("invalid");
    expect(
      assignmentAvailabilitySchema.parse({
        status: "unavailable",
        reason: "host_offline"
      }).status
    ).toBe("unavailable");
    expect(() =>
      assignmentAvailabilitySchema.parse({ status: "ready", reason: "host_offline" })
    ).toThrow();
    expect(() =>
      assignmentAvailabilitySchema.parse({ status: "invalid", reason: "host_offline" })
    ).toThrow();
  });

  it("keeps display projection free of secrets and auth-capable fields", () => {
    const projection = assignmentDisplayProjectionSchema.parse({
      projectId: "project-a",
      workItem: blockRef,
      target: { kind: "exact_host", hostId: "host-1" },
      revision: 2,
      host: {
        hostId: "host-1",
        displayName: "Builder",
        online: true,
        authorizedForProject: true,
        revoked: false,
        capabilitiesSatisfied: true
      },
      availability: { status: "ready", reason: "ready" }
    });
    expect(projection.revision).toBe(2);
    expect(() =>
      assignmentDisplayProjectionSchema.parse({
        ...projection,
        host: {
          ...projection.host,
          token: "pw_host_secret"
        }
      })
    ).toThrow();
  });

  it("requires concurrency facts to stay consistent with optional current record", () => {
    expect(
      assignmentConcurrencyFactsSchema.parse({ currentRevision: 0 })
    ).toEqual({ currentRevision: 0 });
    expect(() =>
      assignmentConcurrencyFactsSchema.parse({ currentRevision: 1 })
    ).toThrow();
    const current = assignmentRecordSchema.parse({
      projectId: "project-a",
      workItem: blockRef,
      target: { kind: "unassigned" },
      revision: 3,
      updatedBy: { kind: "human", id: "human-1" },
      updatedAt: "2026-07-24T12:00:00.000Z"
    });
    expect(
      assignmentConcurrencyFactsSchema.parse({ currentRevision: 3, current }).currentRevision
    ).toBe(3);
    expect(() =>
      assignmentConcurrencyFactsSchema.parse({ currentRevision: 2, current })
    ).toThrow();
  });
});
