/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { PeopleView } from "../renderer/views/PeopleView";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

describe("PeopleView", () => {
  it("renders member onboarding as a standalone named page", () => {
    render(<PeopleView api={null} t={createTranslator("en")} />);

    expect(screen.getByTestId("people-view")).toHaveAccessibleName("Project people");
    expect(screen.getByRole("heading", { level: 1, name: "Project people" })).toBeInTheDocument();
    expect(screen.getByTestId("people-panel")).toHaveAttribute("data-mode", "disconnected");
    expect(screen.getByTestId("people-connect-form")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });
});
