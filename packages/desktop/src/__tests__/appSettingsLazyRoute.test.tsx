/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../renderer/App";

const settingsRouteModule = vi.hoisted(() => {
  let resolveReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  return {
    ready,
    resolve() {
      if (!resolveReady) {
        throw new Error("Settings route module resolver is unavailable.");
      }
      resolveReady();
    }
  };
});
const useAppViewHistory = vi.hoisted(() => vi.fn());
const useDesktopSettingsBridge = vi.hoisted(() => vi.fn());
const useDesktopSettingsEffects = vi.hoisted(() => vi.fn());
const useDetectedAgents = vi.hoisted(() => vi.fn());
const useProjectWorkspace = vi.hoisted(() => vi.fn());
const useResizableSidebarLayout = vi.hoisted(() => vi.fn());
const useRuntimeTools = vi.hoisted(() => vi.fn());

vi.mock("../renderer/AppSettingsRoute", async () => {
  await settingsRouteModule.ready;
  return {
    AppSettingsRoute: () => <div data-testid="settings-route">Settings route</div>
  };
});
vi.mock("../renderer/bridge", () => ({ bridge: {} }));
vi.mock("../renderer/i18n", () => ({ createTranslator: () => (key: string) => key }));
vi.mock("../renderer/rendererPlatform", () => ({ detectRendererPlatform: () => "darwin" }));
vi.mock("../renderer/hooks/useAppViewHistory", () => ({ useAppViewHistory }));
vi.mock("../renderer/hooks/useDesktopSettingsBridge", () => ({ useDesktopSettingsBridge }));
vi.mock("../renderer/hooks/useDesktopSettingsEffects", () => ({ useDesktopSettingsEffects }));
vi.mock("../renderer/hooks/useDetectedAgents", () => ({ useDetectedAgents }));
vi.mock("../renderer/hooks/useResizableSidebarLayout", () => ({ useResizableSidebarLayout }));
vi.mock("../renderer/hooks/useRuntimeTools", () => ({ useRuntimeTools }));
vi.mock("../renderer/ProjectWorkspaceProvider", () => ({
  ProjectWorkspaceProvider: ({ children }: { children: ReactNode }) => children,
  useProjectWorkspace
}));
vi.mock("../renderer/components/AppOverlays", () => ({
  AppOverlays: () => <div data-testid="app-overlays">Overlays</div>
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("App settings lazy route", () => {
  it("keeps overlays visible while the settings route is loading", async () => {
    useDesktopSettingsBridge.mockReturnValue({
      settings: { language: "en" },
      updateLayoutSettings: vi.fn(),
      updateSettings: vi.fn(),
      updateSettingsAndWait: vi.fn().mockResolvedValue(undefined)
    });
    useAppViewHistory.mockReturnValue(["settings", vi.fn(), { historyError: null }]);
    useDetectedAgents.mockReturnValue({
      agentDetectionRefreshing: false,
      agentDetections: [],
      refreshAgentDetections: vi.fn().mockResolvedValue(undefined)
    });
    useRuntimeTools.mockReturnValue({
      refreshRuntimeTools: vi.fn().mockResolvedValue(undefined),
      runtimeTools: {}
    });
    useResizableSidebarLayout.mockReturnValue({
      leftSidebarCollapsed: false,
      leftSidebarWidth: 240,
      rightSidebarCollapsed: false,
      rightSidebarWidth: 320,
      setLeftSidebarCollapsedPreference: vi.fn(),
      setRightSidebarCollapsedPreference: vi.fn(),
      startSidebarResize: vi.fn()
    });
    useProjectWorkspace.mockReturnValue({ settingsRouteProps: {} });

    render(<App />);

    expect(screen.getByText("loadingProject")).toBeInTheDocument();
    expect(screen.getByTestId("app-overlays")).toBeInTheDocument();

    settingsRouteModule.resolve();

    expect(await screen.findByTestId("settings-route")).toBeInTheDocument();
  });
});
