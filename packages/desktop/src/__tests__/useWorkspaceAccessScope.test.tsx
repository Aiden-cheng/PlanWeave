/* @vitest-environment jsdom */

import { renderHook, waitFor } from "@testing-library/react";
import {
  accessCapabilityFlags,
  type CurrentCanvasAccessView
} from "@planweave-ai/collaboration-protocol/access/control";
import { describe, expect, it, vi } from "vitest";
import {
  type WorkspaceAccessScopeApi,
  useWorkspaceAccessScope
} from "../renderer/hooks/useWorkspaceAccessScope";

const accessView: CurrentCanvasAccessView = {
  scope: {
    scopeKind: "canvas",
    workspaceId: "workspace-1",
    projectId: "remote-project",
    canvasId: "remote-canvas"
  },
  projectVisibility: "private",
  canvasVisibility: "shared",
  projectAclRevision: 1,
  canvasAclRevision: 2,
  project: {
    scope: {
      scopeKind: "project",
      workspaceId: "workspace-1",
      projectId: "remote-project",
      canvasId: null
    },
    aclRevision: 1,
    effectiveRole: "owner",
    roleSource: "scope_owner",
    capabilities: accessCapabilityFlags("owner"),
    disabledReason: null
  },
  canvas: {
    scope: {
      scopeKind: "canvas",
      workspaceId: "workspace-1",
      projectId: "remote-project",
      canvasId: "remote-canvas"
    },
    aclRevision: 2,
    effectiveRole: "owner",
    roleSource: "scope_owner",
    capabilities: accessCapabilityFlags("owner"),
    disabledReason: null
  },
  people: []
};

describe("useWorkspaceAccessScope", () => {
  it("loads a Workspace scope independently of the sidebar selection", async () => {
    const getCurrentCanvasAccess = vi.fn().mockResolvedValue(accessView);
    const api: WorkspaceAccessScopeApi = {
      listCollaborationContentBootstrapCandidates: vi.fn().mockResolvedValue([
        {
          workspaceId: "workspace-1",
          projectId: "remote-project",
          canvasId: "remote-canvas",
          visibility: "shared",
          authority: {
            authoritativeHead: null,
            localReplica: null,
            replicaStatus: "snapshot_required"
          },
          localReplica: { projectId: "local-project", canvasId: "local-canvas" }
        }
      ]),
      getLocalCollaborationScopeCatalog: vi.fn().mockResolvedValue({
        projects: [
          {
            projectId: "local-project",
            name: "PlanWeave",
            selectedCanvasCount: 1,
            canvases: [
              {
                canvasId: "local-canvas",
                name: "Task canvas",
                selected: true,
                current: false
              }
            ]
          }
        ],
        selectedCount: 1
      }),
      getCurrentCanvasAccess,
      mutateCurrentCanvasAccess: vi.fn()
    };

    const { result } = renderHook(() =>
      useWorkspaceAccessScope({
        api,
        connectionKey: "profile-1",
        status: {
          session: { phase: "connected" },
          workspaceConnection: { status: "connected" }
        }
      })
    );

    await waitFor(() => expect(result.current.access.view).toEqual(accessView));

    expect(result.current.options).toEqual([
      {
        key: "remote-project\0remote-canvas",
        projectId: "remote-project",
        canvasId: "remote-canvas",
        projectLabel: "PlanWeave",
        canvasLabel: "Task canvas"
      }
    ]);
    expect(result.current.selectedKey).toBe("remote-project\0remote-canvas");
    expect(getCurrentCanvasAccess).toHaveBeenCalledWith({ canvasId: "remote-canvas" });
  });
});
