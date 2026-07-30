/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { defaultDesktopSettings } from "../renderer/settings";
import { SettingsAgentsSection } from "../renderer/settings/SettingsAgentsSection";

const bridgeMock = vi.hoisted(() => ({
  detectWslEnvironment: vi.fn()
}));

vi.mock("../renderer/bridge", () => ({
  bridge: bridgeMock
}));

function installSelectDomStubs() {
  Object.defineProperty(window.HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: vi.fn(() => false)
  });
  Object.defineProperty(window.HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn()
  });
  Object.defineProperty(window.HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: vi.fn()
  });
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn()
  });
}

beforeEach(() => {
  installSelectDomStubs();
  bridgeMock.detectWslEnvironment.mockResolvedValue({
    supported: true,
    available: true,
    distributions: ["Ubuntu"],
    unavailableReason: null
  });
});

afterEach(() => {
  cleanup();
  bridgeMock.detectWslEnvironment.mockReset();
});

describe("settings agents save failures", () => {
  it("does not refresh detections after a failed host save and restores the control", async () => {
    const persistSettings = vi.fn().mockRejectedValue(new Error("settings save failed"));
    const refreshAgentDetections = vi.fn().mockResolvedValue(undefined);
    const setError = vi.fn();
    const t = createTranslator("en");
    render(
      <SettingsAgentsSection
        agentDetectionRefreshing={false}
        agents={[]}
        graph={null}
        persistSettings={persistSettings}
        refreshAgentDetections={refreshAgentDetections}
        setError={setError}
        settings={{
          ...defaultDesktopSettings,
          execution: {
            ...defaultDesktopSettings.execution,
            agentHost: { kind: "wsl", distribution: "Ubuntu" }
          }
        }}
        t={t}
        updateSettings={vi.fn()}
      />
    );

    const hostSelect = await screen.findByRole("combobox", { name: "Agent host" });
    await userEvent.click(hostSelect);
    await userEvent.click(screen.getByRole("option", { name: "Windows Native" }));

    await waitFor(() => expect(persistSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(hostSelect).toBeEnabled());
    expect(refreshAgentDetections).not.toHaveBeenCalled();
  });

  it("reports refresh failures after a successful host save and restores the control", async () => {
    const persistSettings = vi.fn().mockResolvedValue(undefined);
    const refreshAgentDetections = vi
      .fn()
      .mockRejectedValue(new Error("agent detection refresh failed"));
    const setError = vi.fn();
    const t = createTranslator("en");
    render(
      <SettingsAgentsSection
        agentDetectionRefreshing={false}
        agents={[]}
        graph={null}
        persistSettings={persistSettings}
        refreshAgentDetections={refreshAgentDetections}
        setError={setError}
        settings={{
          ...defaultDesktopSettings,
          execution: {
            ...defaultDesktopSettings.execution,
            agentHost: { kind: "wsl", distribution: "Ubuntu" }
          }
        }}
        t={t}
        updateSettings={vi.fn()}
      />
    );

    const hostSelect = await screen.findByRole("combobox", { name: "Agent host" });
    await userEvent.click(hostSelect);
    await userEvent.click(screen.getByRole("option", { name: "Windows Native" }));

    await waitFor(() => expect(refreshAgentDetections).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(setError).toHaveBeenCalledWith("agent detection refresh failed"));
    await waitFor(() => expect(hostSelect).toBeEnabled());
  });
});
