/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  accessCapabilityFlags,
  type CurrentCanvasAccessView
} from "@planweave-ai/collaboration-protocol/access/control";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CurrentCanvasAccessPanel,
  CurrentCanvasMemberAccess
} from "../renderer/collaboration/CurrentCanvasAccessPanel";
import { createTranslator } from "../renderer/i18n";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const t = createTranslator("en");
const scope = {
  scopeKind: "canvas" as const,
  workspaceId: "workspace-access-001",
  projectId: "project-access-001",
  canvasId: "canvas-access-001"
};

function accessView(
  projectRole: "owner" | "editor" | "viewer",
  canvasRole: "owner" | "editor" | "viewer" = projectRole
): CurrentCanvasAccessView {
  return {
    scope,
    projectVisibility: "private",
    canvasVisibility: "shared",
    projectAclRevision: 3,
    canvasAclRevision: 5,
    project: {
      scope: { ...scope, scopeKind: "project", canvasId: null },
      aclRevision: 3,
      effectiveRole: projectRole,
      roleSource: projectRole === "owner" ? "scope_owner" : "shared_workspace_membership",
      capabilities: accessCapabilityFlags(projectRole),
      disabledReason: null
    },
    canvas: {
      scope,
      aclRevision: 5,
      effectiveRole: canvasRole,
      roleSource: canvasRole === "owner" ? "scope_owner" : "shared_workspace_membership",
      capabilities: accessCapabilityFlags(canvasRole),
      disabledReason: null
    },
    people: [
      {
        humanPrincipalId: "human-member-001",
        displayName: "Member",
        membership: "active",
        effectiveRole: "viewer",
        capabilities: accessCapabilityFlags("viewer"),
        disabledReason: null,
        grants:
          projectRole === "owner" || canvasRole === "owner"
            ? [
                { grantId: "grant-project-viewer-001", scopeKind: "project", role: "viewer" },
                { grantId: "grant-canvas-viewer-001", scopeKind: "canvas", role: "viewer" }
              ]
            : []
      }
    ]
  };
}

afterEach(cleanupRendererTestEnvironment);

describe("CurrentCanvasAccessPanel", () => {
  it("uses the capability view for owner visibility controls and write states", async () => {
    const onUpdateVisibility = vi.fn().mockResolvedValue(null);
    render(
      <CurrentCanvasAccessPanel
        view={accessView("owner")}
        loading={false}
        error={null}
        busy={false}
        t={t}
        onRefresh={vi.fn()}
        onUpdateVisibility={onUpdateVisibility}
      />
    );

    expect(screen.getByTestId("canvas-access-role")).toHaveTextContent(
      "Effective role: project Owner · canvas Owner"
    );
    expect(
      screen.getByRole("radiogroup", { name: "Current canvas visibility" })
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Private/ })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /Shared/ })).toBeChecked();
    expect(screen.getAllByTestId("canvas-access-capability")).toHaveLength(4);
    expect(screen.getByTestId("canvas-access-panel")).not.toHaveClass("rounded-xl", "border");
    expect(screen.getByTestId("canvas-access-section-icon")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Canvas access" })).toHaveClass("text-base");
    expect(screen.getByTestId("canvas-access-canvas-visibility")).not.toHaveClass(
      "rounded-lg",
      "border"
    );
    for (const capability of screen.getAllByTestId("canvas-access-capability")) {
      expect(capability).not.toHaveClass("rounded-lg", "border");
    }
    expect(screen.queryByTestId("canvas-access-people")).not.toBeInTheDocument();
    expect(screen.getByTestId("canvas-access-project-private")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByTestId("canvas-access-project-private")).not.toBeDisabled();
    expect(screen.getByTestId("canvas-access-project-shared")).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    await userEvent.click(screen.getByTestId("canvas-access-project-shared"));
    expect(onUpdateVisibility).toHaveBeenCalledWith("project", "shared");
  });

  it("keeps owner-only visibility visible but disabled for viewers with a stable reason", () => {
    render(
      <CurrentCanvasAccessPanel
        view={accessView("viewer")}
        loading={false}
        error={null}
        busy={false}
        t={t}
        onRefresh={vi.fn()}
        onUpdateVisibility={vi.fn()}
      />
    );

    const projectVisibility = screen.getByTestId("canvas-access-project-shared");
    expect(projectVisibility).toBeDisabled();
    expect(projectVisibility).toHaveAttribute("title", "This action requires an owner capability.");
    expect(screen.getAllByText("This action requires an owner capability.")).toHaveLength(4);
  });

  it("keeps owner-only visibility visible but disabled for editors", () => {
    render(
      <CurrentCanvasAccessPanel
        view={accessView("editor")}
        loading={false}
        error={null}
        busy={false}
        t={t}
        onRefresh={vi.fn()}
        onUpdateVisibility={vi.fn()}
      />
    );

    expect(screen.getByTestId("canvas-access-canvas-private")).toBeDisabled();
    expect(screen.getByTestId("canvas-access-canvas-private")).toHaveAttribute(
      "title",
      "This action requires an owner capability."
    );
  });

  it("binds project controls to project access when canvas ownership is independent", async () => {
    const onGrant = vi.fn().mockResolvedValue(null);
    const view = accessView("owner", "viewer");
    render(
      <CurrentCanvasMemberAccess
        view={view}
        person={view.people[0]!}
        busy={false}
        t={t}
        onGrant={onGrant}
        onRevoke={vi.fn()}
      />
    );

    await userEvent.click(screen.getByTestId("canvas-access-grant-project-viewer"));
    expect(onGrant).toHaveBeenCalledWith("human-member-001", "viewer", "project");
    expect(screen.getByTestId("canvas-access-grant-canvas-viewer")).toBeDisabled();
  });

  it("binds canvas controls to canvas access when project ownership is independent", async () => {
    const onGrant = vi.fn().mockResolvedValue(null);
    const view = accessView("viewer", "owner");
    render(
      <CurrentCanvasMemberAccess
        view={view}
        person={view.people[0]!}
        busy={false}
        t={t}
        onGrant={onGrant}
        onRevoke={vi.fn()}
      />
    );

    await userEvent.click(screen.getByTestId("canvas-access-grant-canvas-editor"));
    expect(onGrant).toHaveBeenCalledWith("human-member-001", "editor", "canvas");
    expect(screen.getByTestId("canvas-access-grant-project-editor")).toBeDisabled();
  });
});
