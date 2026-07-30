/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  CollaborationWorkspaceOnboarding,
  type CollaborationWorkspaceOnboardingProps
} from "./CollaborationWorkspaceOnboarding";

const t: CollaborationWorkspaceOnboardingProps["t"] = (key) => key;

describe("CollaborationWorkspaceOnboarding", () => {
  it("progressively reveals local and existing-server creation slots", async () => {
    const user = userEvent.setup();
    render(
      <CollaborationWorkspaceOnboarding
        t={t}
        localHostingSlot={<div data-testid="local-hosting-slot">local hosting</div>}
        existingServerSlot={<div data-testid="existing-server-slot">existing server</div>}
        joinSlot={<div>join action</div>}
      />
    );

    expect(screen.getByTestId("collaboration-onboarding-create")).toBeVisible();
    expect(screen.getByTestId("collaboration-onboarding-join")).toBeVisible();
    expect(screen.queryByTestId("local-hosting-slot")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("collaboration-onboarding-create"));
    await user.click(screen.getByTestId("collaboration-onboarding-host-locally"));

    expect(screen.getByTestId("local-hosting-slot")).toBeVisible();
    expect(screen.queryByTestId("existing-server-slot")).not.toBeInTheDocument();
  });

  it("renders the supplied join slot without adding a second invitation input", async () => {
    const user = userEvent.setup();
    render(
      <CollaborationWorkspaceOnboarding
        t={t}
        localHostingSlot={null}
        existingServerSlot={null}
        joinSlot={<div data-testid="join-slot">join action</div>}
      />
    );

    await user.click(screen.getByTestId("collaboration-onboarding-join"));

    expect(screen.getByTestId("join-slot")).toHaveTextContent("join action");
    expect(
      screen.queryByTestId("collaboration-onboarding-invitation-input")
    ).not.toBeInTheDocument();
    expect(screen.getByText("collaborationOnboardingSaasNote")).toBeVisible();
  });
});
