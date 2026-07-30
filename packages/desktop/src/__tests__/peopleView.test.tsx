/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { PeopleView } from "../renderer/views/PeopleView";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const scopeLayout = { collapsed: true, expandedProjectIds: [] };
const onScopeLayoutChange = () => undefined;

afterEach(cleanupRendererTestEnvironment);

describe("PeopleView", () => {
  it("renders member onboarding as a standalone named page", () => {
    render(
      <PeopleView
        api={null}
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    expect(screen.getByTestId("people-view")).toHaveAccessibleName("Project people");
    expect(screen.getByTestId("people-view")).not.toHaveClass("border");
    expect(screen.queryByRole("heading", { name: "Project people" })).not.toBeInTheDocument();
    expect(screen.getByTestId("people-panel")).toHaveAttribute("data-mode", "disconnected");
    expect(screen.getByTestId("people-connect-form")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });

  it("hides remote content authority while the project is local only", () => {
    render(
      <PeopleView
        api={null}
        canvasId="canvas-1"
        t={createTranslator("en")}
        collaborationScopeLayout={scopeLayout}
        onCollaborationScopeLayoutChange={onScopeLayoutChange}
      />
    );

    expect(screen.queryByTestId("content-authority-panel")).not.toBeInTheDocument();
  });
});
