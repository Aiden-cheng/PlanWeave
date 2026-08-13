/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { SettingsNav } from "../renderer/settings/SettingsNav";

afterEach(cleanup);

describe("SettingsNav", () => {
  it("hides Project Doctor outside developer mode", () => {
    render(
      <SettingsNav
        developerMode={false}
        section="general"
        setSection={vi.fn()}
        onBackToApp={vi.fn()}
        t={createTranslator("en")}
      />
    );

    expect(screen.queryByTestId("settings-nav-project-doctor")).toBeNull();
  });

  it("shows Project Doctor in developer mode", () => {
    render(
      <SettingsNav
        developerMode
        section="general"
        setSection={vi.fn()}
        onBackToApp={vi.fn()}
        t={createTranslator("en")}
      />
    );

    expect(screen.getByTestId("settings-nav-project-doctor")).not.toBeNull();
  });

  it("opens credential storage from its own Security & Credentials section", () => {
    const setSection = vi.fn();
    render(
      <SettingsNav
        developerMode={false}
        section="general"
        setSection={setSection}
        onBackToApp={vi.fn()}
        t={createTranslator("en")}
      />
    );

    const securityNav = screen.getByTestId("settings-nav-security");
    expect(securityNav.textContent).toContain("Security & Credentials");

    fireEvent.click(securityNav);
    expect(setSection).toHaveBeenCalledWith("security");
  });
});
