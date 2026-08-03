/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkAuthorityProjection, WorkItemRef } from "@planweave-ai/collaboration-protocol";
import {
  acquireCollaborationReadModelController,
  resetCollaborationReadModelHubForTests
} from "../renderer/collaboration/collaborationReadModelHub";
import type { CollaborationReadBridgePort } from "../renderer/collaboration/CollaborationReadModelController";
import { createTranslator } from "../renderer/i18n";
import { AssigneeInspectorField } from "../renderer/team/AssigneeInspectorField";
import type {
  CollaborationObserverSignal,
  CollaborationStatus,
  PlanWeaveCollaborationApi
} from "../shared/collaboration";
import {
  cleanupRendererTestEnvironment,
  stubSelectLayoutApis
} from "./helpers/rendererTestEnvironment";

const taskItem: WorkItemRef = { kind: "task", canvasId: "canvas-1", taskId: "T-1" };
const firstBlock: Extract<WorkItemRef, { kind: "block" }> = {
  kind: "block",
  canvasId: "canvas-1",
  blockRef: "T-1#B-001"
};
const secondBlock: Extract<WorkItemRef, { kind: "block" }> = {
  kind: "block",
  canvasId: "canvas-1",
  blockRef: "T-1#B-002"
};
const blockedBlock: Extract<WorkItemRef, { kind: "block" }> = {
  kind: "block",
  canvasId: "canvas-1",
  blockRef: "T-1#B-003"
};

type AssigneeFieldApi = Pick<
  PlanWeaveCollaborationApi,
  keyof CollaborationReadBridgePort | "dispatchCollaborationRemoteOperation"
>;

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
        updatedAt: "2030-01-01T00:00:00.000Z"
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
    workspaceConnection: {
      schemaVersion: "workspace-setup/v1",
      status: "local_only",
      profile: null,
      workspaceId: null,
      workspaceDisplayName: null,
      connectedAt: null,
      error: null
    },
    workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null },
    updatedAt: "2030-01-01T00:00:00.000Z"
  };
}

function authorityFor(workItem: WorkItemRef): WorkAuthorityProjection {
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

  return {
    schemaVersion: "work-authority/v1",
    scope,
    responsibility: {
      schemaVersion: "responsibility/v1",
      scope,
      principal: null,
      revision: 0,
      updatedAt: "2030-01-01T00:00:00.000Z",
      availability: "unassigned"
    },
    reviewer: {
      schemaVersion: "review-assignment/v1",
      scope,
      principal: null,
      revision: 0,
      updatedAt: "2030-01-01T00:00:00.000Z",
      availability: "unassigned"
    },
    executionTarget:
      workItem.kind === "block"
        ? {
            schemaVersion: "execution-target/v1",
            scope,
            target: { kind: "unassigned" },
            revision: 0,
            updatedAt: "2030-01-01T00:00:00.000Z",
            availability: { status: "unassigned", reason: "unassigned" }
          }
        : null,
    revisions: {
      responsibilityRevision: 0,
      reviewerRevision: 0,
      executionTargetRevision: 0
    },
    selectedHost: null,
    evaluatedAt: "2030-01-01T00:00:00.000Z"
  };
}

function eligibleHosts(workItem: WorkItemRef) {
  return {
    workItem,
    humans: [],
    hosts: [
      {
        projectId: "project-1",
        hostId: "host-1",
        displayName: "Builder",
        exists: true,
        revoked: false,
        authorizedForProject: true,
        online: true,
        capabilities: ["acp.codex"],
        capacityRemaining: 1
      }
    ],
    nextHumanCursor: null,
    nextHostCursor: null
  };
}

function createApi(): AssigneeFieldApi {
  const getWorkAuthority = vi.fn(async ({ workItem }: { workItem: WorkItemRef }) =>
    authorityFor(workItem)
  );
  return {
    getCollaborationStatus: vi.fn().mockResolvedValue(connectedStatus()),
    listCollaborationMembers: vi.fn().mockResolvedValue({
      items: [
        {
          membershipId: "membership-1",
          projectId: "project-1",
          humanPrincipalId: "human-1",
          displayName: "Ada",
          role: "owner",
          createdAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z"
        }
      ],
      nextCursor: null
    }),
    listCollaborationAssignments: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCollaborationEligibleAssignees: vi.fn(async ({ workItem }: { workItem: WorkItemRef }) =>
      eligibleHosts(workItem)
    ),
    getCollaborationWorkAuthority: getWorkAuthority,
    updateCollaborationResponsibility: vi.fn(),
    updateCollaborationReviewer: vi.fn(),
    updateCollaborationExecutionTarget: vi.fn(async ({ workItem, target }) => ({
      ...authorityFor(workItem).executionTarget!,
      target,
      revision: 1
    })),
    listCollaborationComments: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCollaborationActivity: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    updateCollaborationAssignment: vi.fn(),
    createCollaborationComment: vi.fn(),
    editCollaborationComment: vi.fn(),
    tombstoneCollaborationComment: vi.fn(),
    dispatchCollaborationRemoteOperation: vi.fn(async ({ blockRef }: { blockRef: string }) => {
      if (blockRef === secondBlock.blockRef) {
        throw new Error("remote_dispatch_failed");
      }
      return { operationId: `operation-${blockRef}` };
    }),
    onCollaborationStatusChanged: vi.fn(() => () => undefined),
    onCollaborationObserverSignal: vi.fn(
      (_callback: (signal: CollaborationObserverSignal) => void) => () => undefined
    )
  };
}

async function prepare(api: AssigneeFieldApi) {
  const shell = acquireCollaborationReadModelController(api);
  await shell.controller.setActiveProject({
    profileId: "profile-1",
    projectId: "project-1",
    canvasId: "canvas-1"
  });
  return shell;
}

afterEach(() => {
  cleanupRendererTestEnvironment();
  resetCollaborationReadModelHubForTests();
});

describe("AssigneeInspectorField Task Host dispatch results", () => {
  it("shows the result for every Block after an exact Host Task dispatch", async () => {
    stubSelectLayoutApis();
    const user = userEvent.setup();
    const api = createApi();
    const shell = await prepare(api);

    render(
      <AssigneeInspectorField
        workItem={taskItem}
        roles={["execution_target"]}
        taskExecutionBlocks={[
          { workItem: firstBlock, dispatchable: true },
          { workItem: secondBlock, dispatchable: true },
          { workItem: blockedBlock, dispatchable: false }
        ]}
        api={api as PlanWeaveCollaborationApi}
        t={createTranslator("en")}
      />
    );

    const field = await screen.findByTestId("authority-field-execution_target");
    await user.click(within(field).getByTestId("assignee-picker-trigger"));
    const hostOption = (await screen.findAllByTestId("assignee-option")).find(
      (option) => option.getAttribute("data-option-id") === "exact_host:host-1"
    );
    expect(hostOption).toBeTruthy();
    await user.click(hostOption!);

    const results = await within(field).findByTestId("task-host-dispatch-results");
    expect(results).toHaveTextContent("Block dispatch results");
    expect(results).toHaveTextContent(`${firstBlock.blockRef}: Dispatched`);
    expect(results).toHaveTextContent(`${secondBlock.blockRef}: Dispatch failed`);
    expect(results).toHaveTextContent(`${blockedBlock.blockRef}: Not ready to dispatch`);
    expect(api.dispatchCollaborationRemoteOperation).toHaveBeenCalledTimes(2);

    shell.release();
  });

  it("keeps the Block execution picker Host and automatic choices available", async () => {
    stubSelectLayoutApis();
    const user = userEvent.setup();
    const api = createApi();
    const shell = await prepare(api);

    render(
      <AssigneeInspectorField
        workItem={firstBlock}
        roles={["execution_target"]}
        api={api as PlanWeaveCollaborationApi}
        t={createTranslator("en")}
      />
    );

    const field = await screen.findByTestId("authority-field-execution_target");
    await user.click(within(field).getByTestId("assignee-picker-trigger"));
    expect(await screen.findByTestId("assignee-section-hosts")).toBeInTheDocument();
    expect(screen.getByTestId("assignee-section-automatic")).toBeInTheDocument();

    const automaticOption = screen
      .getAllByTestId("assignee-option")
      .find((option) => option.getAttribute("data-option-id") === "automatic_host");
    expect(automaticOption).toBeTruthy();
    await user.click(automaticOption!);
    await waitFor(() => {
      expect(api.updateCollaborationExecutionTarget).toHaveBeenCalledWith(
        expect.objectContaining({
          workItem: firstBlock,
          target: { kind: "automatic_host" }
        })
      );
    });

    shell.release();
  });
});
