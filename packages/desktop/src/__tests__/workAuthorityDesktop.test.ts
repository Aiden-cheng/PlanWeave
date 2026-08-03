/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WorkAuthorityProjection,
  WorkItemRef
} from "@planweave-ai/collaboration-protocol";
import {
  acquireCollaborationReadModelController,
  resetCollaborationReadModelHubForTests
} from "../renderer/collaboration/collaborationReadModelHub";
import type { CollaborationReadBridgePort } from "../renderer/collaboration/CollaborationReadModelController";
import {
  assignmentProjectionFromAuthority,
  useAssigneePickerController
} from "../renderer/hooks/useAssigneePickerController";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../shared/collaboration";
import {
  collaborationExecutionTargetUpdateInputSchema,
  workItemKey
} from "../shared/collaborationReadModels";
import { createTranslator } from "../renderer/i18n";

const taskItem: WorkItemRef = { kind: "task", canvasId: "canvas-1", taskId: "T-1" };
const blockItem: WorkItemRef = { kind: "block", canvasId: "canvas-1", blockRef: "T-1#B-001" };

function connectedStatus(): CollaborationStatus {
  return {
    profiles: [
      {
        profileId: "profile-1",
        displayName: "Demo",
        serverBaseUrl: "https://example.test",
        projectId: "project-1",
        allowInsecureTransport: false,
        hasDeviceCredential: true,
        deviceCredentialPersistence: "persisted",
        deviceCredentialId: "device-1",
        humanPrincipalId: "human-1",
        updatedAt: "2030-01-01T00:00:00.000Z",
      }
    ],
    activeProfileId: "profile-1",
    credentialStorage: "available",
    nonPersistenceWarning: null,
    session: {
      phase: "connected",
      activeProfileId: "profile-1",
      detail: null,
      lastErrorCode: null,
      lastErrorMessage: null
    },
    updatedAt: "2030-01-01T00:00:00.000Z",
  workspaceConnection: {
    schemaVersion: "workspace-setup/v1",
    status: "local_only",
    profile: null,
    workspaceId: null,
    workspaceDisplayName: null,
    connectedAt: null,
    error: null
  },
  workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null }
  };
}

function authorityFor(
  workItem: WorkItemRef,
  overrides: Partial<WorkAuthorityProjection> = {}
): WorkAuthorityProjection {
  const scope =
    workItem.kind === "task"
      ? {
          kind: "task" as const,
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: workItem.canvasId,
          taskId: workItem.taskId
        }
      : {
          kind: "block" as const,
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: workItem.canvasId,
          blockRef: workItem.blockRef
        };
  const base: WorkAuthorityProjection = {
    schemaVersion: "work-authority/v1",
    scope,
    responsibility: {
      schemaVersion: "responsibility/v1",
      scope,
      principal: { kind: "human", humanPrincipalId: "human-1" },
      revision: 1,
      updatedAt: "2030-01-01T00:00:00.000Z",
      availability: "active"
    },
    reviewer: {
      schemaVersion: "review-assignment/v1",
      scope,
      principal: { kind: "human", humanPrincipalId: "human-2" },
      revision: 2,
      updatedAt: "2030-01-01T00:00:00.000Z",
      availability: "active"
    },
    executionTarget:
      workItem.kind === "block"
        ? {
            schemaVersion: "execution-target/v1",
            scope: scope as Extract<typeof scope, { kind: "block" }>,
            target: { kind: "exact_host", hostId: "host-1" },
            revision: 3,
            updatedAt: "2030-01-01T00:00:00.000Z",
            availability: { status: "ready", reason: "ready" }
          }
        : null,
    revisions: {
      responsibilityRevision: 1,
      reviewerRevision: 2,
      executionTargetRevision: workItem.kind === "block" ? 3 : 0
    },
    selectedHost:
      workItem.kind === "block"
        ? {
            hostId: "host-1",
            availabilityReason: "ready",
            lease: { status: "none", leaseId: null, expiresAt: null },
            authorization: {
              schemaVersion: "host-authorization/v1",
              scope: scope as Extract<typeof scope, { kind: "block" }>,
              hostId: "host-1",
              decision: "deny",
              reason: "lease_missing",
              currentRevisions: {
                responsibilityRevision: 1,
                reviewerRevision: 2,
                executionTargetRevision: 3
              },
              evaluatedAt: "2030-01-01T00:00:00.000Z"
            }
          }
        : null,
    evaluatedAt: "2030-01-01T00:00:00.000Z"
  };
  return { ...base, ...overrides };
}

function createApi(handlers: {
  updateResponsibility?: ReturnType<typeof vi.fn>;
  updateReviewer?: ReturnType<typeof vi.fn>;
  updateExecutionTarget?: ReturnType<typeof vi.fn>;
  getWorkAuthority?: ReturnType<typeof vi.fn>;
} = {}) {
  const status = connectedStatus();
  const authorityState = new Map<string, WorkAuthorityProjection>();
  authorityState.set(workItemKey(taskItem), authorityFor(taskItem));
  authorityState.set(workItemKey(blockItem), authorityFor(blockItem));

  const getWorkAuthority =
    handlers.getWorkAuthority ??
    vi.fn(async (input: { workItem: WorkItemRef }) => {
      return authorityState.get(workItemKey(input.workItem)) ?? authorityFor(input.workItem);
    });
  const updateResponsibility =
    handlers.updateResponsibility ??
    vi.fn(async (input: { workItem: WorkItemRef; principal: unknown; expectedRevision: number }) => {
      const current = authorityState.get(workItemKey(input.workItem))!;
      if (input.expectedRevision !== current.responsibility.revision) {
        const error = Object.assign(new Error("stale"), {
          kind: "conflict",
          code: "work_revision_conflict",
          retryable: false
        });
        throw error;
      }
      const next = authorityFor(input.workItem, {
        responsibility: {
          ...current.responsibility,
          principal: input.principal as WorkAuthorityProjection["responsibility"]["principal"],
          revision: current.responsibility.revision + 1
        },
        revisions: {
          ...current.revisions,
          responsibilityRevision: current.responsibility.revision + 1
        }
      });
      authorityState.set(workItemKey(input.workItem), next);
      return next.responsibility;
    });
  const updateReviewer =
    handlers.updateReviewer ??
    vi.fn(async (input: { workItem: WorkItemRef; principal: unknown; expectedRevision: number }) => {
      const current = authorityState.get(workItemKey(input.workItem))!;
      const next = authorityFor(input.workItem, {
        reviewer: {
          ...current.reviewer,
          principal: input.principal as WorkAuthorityProjection["reviewer"]["principal"],
          revision: current.reviewer.revision + 1
        },
        revisions: {
          ...current.revisions,
          reviewerRevision: current.reviewer.revision + 1
        }
      });
      authorityState.set(workItemKey(input.workItem), next);
      return next.reviewer;
    });
  const updateExecutionTarget =
    handlers.updateExecutionTarget ??
    vi.fn(async (input: { workItem: WorkItemRef; target: unknown; expectedRevision: number }) => {
      const current = authorityState.get(workItemKey(input.workItem))!;
      const next = authorityFor(input.workItem, {
        executionTarget: {
          schemaVersion: "execution-target/v1",
          scope: current.scope as Extract<WorkAuthorityProjection["scope"], { kind: "block" }>,
          target: input.target as NonNullable<WorkAuthorityProjection["executionTarget"]>["target"],
          revision: (current.executionTarget?.revision ?? 0) + 1,
          updatedAt: "2030-01-01T00:00:00.000Z",
          availability: { status: "ready", reason: "ready" }
        },
        revisions: {
          ...current.revisions,
          executionTargetRevision: (current.executionTarget?.revision ?? 0) + 1
        }
      });
      authorityState.set(workItemKey(input.workItem), next);
      return next.executionTarget!;
    });

  const api = {
    getCollaborationStatus: vi.fn().mockResolvedValue(status),
    listCollaborationMembers: vi.fn().mockResolvedValue({
      items: [
        {
          membershipId: "m-1",
          projectId: "project-1",
          humanPrincipalId: "human-1",
          displayName: "Ada",
          role: "owner",
          createdAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z",
        },
        {
          membershipId: "m-2",
          projectId: "project-1",
          humanPrincipalId: "human-2",
          displayName: "Bob",
          role: "member",
          createdAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z",
        }
      ],
      nextCursor: null
    }),
    listCollaborationAssignments: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCollaborationEligibleAssignees: vi.fn().mockResolvedValue({
      workItem: blockItem,
      humans: [
        {
          humanPrincipalId: "human-1",
          displayName: "Ada",
          membershipActive: true
        },
        {
          humanPrincipalId: "human-2",
          displayName: "Bob",
          membershipActive: true
        }
      ],
      hosts: [
        {
          hostId: "host-1",
          displayName: "Builder",
          exists: true,
          revoked: false,
          authorizedForProject: true,
          online: true,
          capabilities: ["acp.codex"],
          capacityRemaining: 1
        },
        {
          hostId: "host-revoked",
          displayName: "Revoked",
          exists: true,
          revoked: true,
          authorizedForProject: false,
          online: false,
          capabilities: [],
          capacityRemaining: 0
        }
      ],
      nextHumanCursor: null,
      nextHostCursor: null
    }),
    getCollaborationWorkAuthority: getWorkAuthority,
    updateCollaborationResponsibility: updateResponsibility,
    updateCollaborationReviewer: updateReviewer,
    updateCollaborationExecutionTarget: updateExecutionTarget,
    listCollaborationComments: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCollaborationActivity: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    updateCollaborationAssignment: vi.fn(),
    createCollaborationComment: vi.fn(),
    editCollaborationComment: vi.fn(),
    tombstoneCollaborationComment: vi.fn(),
    onCollaborationStatusChanged: vi.fn(() => () => undefined),
    onCollaborationObserverSignal: vi.fn(() => () => undefined)
  } as unknown as PlanWeaveCollaborationApi & CollaborationReadBridgePort;

  return {
    api,
    updateResponsibility,
    updateReviewer,
    updateExecutionTarget,
    getWorkAuthority,
    authorityState
  };
}

afterEach(() => {
  resetCollaborationReadModelHubForTests();
  vi.restoreAllMocks();
});

describe("desktop work authority wiring (OSS-003#B-003)", () => {
  it("keeps responsibility CAS independent from reviewer and execution target", async () => {
    const { api, updateResponsibility, updateReviewer, updateExecutionTarget } = createApi();
    const shell = acquireCollaborationReadModelController(api);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "canvas-1"
    });

    const { result } = renderHook(() =>
      useAssigneePickerController({
        workItem: blockItem,
        authorityRole: "responsibility",
        api,
        detailsOpen: true,
        t: createTranslator("en")
      })
    );

    await waitFor(() => {
      expect(result.current.authority?.revisions.responsibilityRevision).toBe(1);
    });

    await act(async () => {
      await result.current.selectTarget({ kind: "human", humanPrincipalId: "human-2" });
    });

    expect(updateResponsibility).toHaveBeenCalledWith(
      expect.objectContaining({
        workItem: blockItem,
        principal: { kind: "human", humanPrincipalId: "human-2" },
        expectedRevision: 1
      })
    );
    expect(updateReviewer).not.toHaveBeenCalled();
    expect(updateExecutionTarget).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(result.current.authority?.revisions.executionTargetRevision).toBe(3);
      expect(result.current.authority?.reviewer.revision).toBe(2);
    });
  });

  it("rejects Task Host execution targets at IPC schema and controller boundaries", async () => {
    expect(() =>
      collaborationExecutionTargetUpdateInputSchema.parse({
        workItem: taskItem,
        target: { kind: "exact_host", hostId: "host-1" },
        expectedRevision: 0
      })
    ).toThrow(/execution_target_requires_exact_block/);

    const { api, updateExecutionTarget } = createApi();
    const shell = acquireCollaborationReadModelController(api);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "canvas-1"
    });

    const { result } = renderHook(() =>
      useAssigneePickerController({
        workItem: taskItem,
        authorityRole: "execution_target",
        api,
        detailsOpen: true,
        t: createTranslator("en")
      })
    );

    await act(async () => {
      const ok = await result.current.selectTarget({
        kind: "exact_host",
        hostId: "host-1"
      });
      expect(ok).toBe(false);
    });
    expect(updateExecutionTarget).not.toHaveBeenCalled();
  });

  it("does not couple reviewer identity to selected Host execution target", () => {
    const authority = authorityFor(blockItem);
    const responsibility = assignmentProjectionFromAuthority({
      workItem: blockItem,
      projectId: "project-1",
      authority,
      role: "responsibility"
    });
    const reviewer = assignmentProjectionFromAuthority({
      workItem: blockItem,
      projectId: "project-1",
      authority,
      role: "reviewer"
    });
    const execution = assignmentProjectionFromAuthority({
      workItem: blockItem,
      projectId: "project-1",
      authority,
      role: "execution_target"
    });
    expect(responsibility?.target).toEqual({ kind: "human", humanPrincipalId: "human-1" });
    expect(reviewer?.target).toEqual({ kind: "human", humanPrincipalId: "human-2" });
    expect(execution?.target).toEqual({ kind: "exact_host", hostId: "host-1" });
    expect(execution?.revision).toBe(3);
    expect(reviewer?.revision).toBe(2);
  });

  it("surfaces revoked Hosts as non-selectable while keeping human roles independent", async () => {
    const { api } = createApi();
    const shell = acquireCollaborationReadModelController(api);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "canvas-1"
    });

    const { result } = renderHook(() =>
      useAssigneePickerController({
        workItem: blockItem,
        authorityRole: "execution_target",
        api,
        detailsOpen: true,
        t: createTranslator("en")
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel).toBeTruthy();
      expect(result.current.viewModel?.sections.some((section) => section.id === "hosts")).toBe(
        true
      );
    });

    const revoked = result.current.viewModel?.filteredOptions.find(
      (option) => option.kind === "exact_host" && option.target.kind === "exact_host"
        ? option.target.hostId === "host-revoked"
        : false
    );
    expect(revoked?.selectable).toBe(false);
    expect(revoked?.unavailableReason).toBe("host_revoked");
    expect(
      result.current.viewModel?.sections.some((section) => section.id === "people")
    ).toBe(false);
  });
});
