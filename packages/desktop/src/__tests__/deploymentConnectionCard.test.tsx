/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { DeploymentConnectionCard } from "../renderer/settings/DeploymentConnectionCard";

describe("DeploymentConnectionCard", () => {
  afterEach(cleanup);

  it("enables deployment guidance without an authenticated Workspace connection", async () => {
    const user = userEvent.setup();
    render(<DeploymentConnectionCard hosts={[]} t={createTranslator("en")} />);

    await user.type(screen.getByTestId("deployment-display-name"), "Local Server");
    await user.type(screen.getByTestId("deployment-origin"), "http://127.0.0.1:7443");

    expect(screen.getByRole("button", { name: "Review handoff" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Validate endpoint" })).toBeEnabled();
  });
});
