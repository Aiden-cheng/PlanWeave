/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { accessCapabilityFlags, type CurrentCanvasAccessView } from "@planweave-ai/collaboration-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CurrentCanvasAccessPanel } from "../renderer/collaboration/CurrentCanvasAccessPanel";
import { createTranslator } from "../renderer/i18n";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const t = createTranslator("en");
const scope = {
  scopeKind: "canvas" as const,
  workspaceId: "workspace-access-001",
  projectId: "project-access-001",
  canvasId: "canvas-access-001"
};

function accessView(role: "owner" | "editor" | "viewer"): CurrentCanvasAccessView {
  return {
    scope,
    projectVisibility: "private",
    canvasVisibility: "shared",
    projectAclRevision: 3,
    canvasAclRevision: 5,
    current: {
      scope,
      aclRevision: 5,
      effectiveRole: role,
      roleSource: role === "owner" ? "scope_owner" : "shared_workspace_membership",
      capabilities: accessCapabilityFlags(role),
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
        grants: role === "owner" ? [{ grantId: "grant-canvas-viewer-001", scopeKind: "canvas", role: "viewer" }] : []
      }
    ]
  };
}

afterEach(cleanupRendererTestEnvironment);

describe("CurrentCanvasAccessPanel", () => {
  it("uses the capability view for owner visibility controls and write states", async () => {
    const onUpdateVisibility = vi.fn().mockResolvedValue(null);
    const onRevoke = vi.fn().mockResolvedValue(null);
    render(
      <CurrentCanvasAccessPanel
        view={accessView("owner")}
        loading={false}
        error={null}
        busy={false}
        t={t}
        onRefresh={vi.fn()}
        onUpdateVisibility={onUpdateVisibility}
        onGrant={vi.fn()}
        onRevoke={onRevoke}
      />
    );

    expect(screen.getByTestId("canvas-access-role")).toHaveTextContent("Effective role: Owner");
    expect(screen.getAllByTestId("canvas-access-capability")).toHaveLength(4);
    await userEvent.click(screen.getByTestId("canvas-access-project-shared"));
    expect(onUpdateVisibility).toHaveBeenCalledWith("project", "shared");
    expect(screen.getByTestId("canvas-access-revoke")).toBeEnabled();
    await userEvent.click(screen.getByTestId("canvas-access-revoke"));
    expect(onRevoke).toHaveBeenCalledWith({
      grantId: "grant-canvas-viewer-001",
      scopeKind: "canvas",
      role: "viewer"
    });
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
        onGrant={vi.fn()}
        onRevoke={vi.fn()}
      />
    );

    const projectVisibility = screen.getByTestId("canvas-access-project-shared");
    expect(projectVisibility).toBeDisabled();
    expect(projectVisibility).toHaveAttribute("title", "This action requires an owner capability.");
    expect(screen.getAllByText("This action requires an owner capability.")).toHaveLength(4);
    expect(screen.getByTestId("canvas-access-no-revocable-grant")).toHaveTextContent(
      "No explicit grant to revoke"
    );
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
        onGrant={vi.fn()}
        onRevoke={vi.fn()}
      />
    );

    expect(screen.getByTestId("canvas-access-canvas-private")).toBeDisabled();
    expect(screen.getByTestId("canvas-access-canvas-private")).toHaveAttribute(
      "title",
      "This action requires an owner capability."
    );
  });
});
