/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { SettingsCredentialStorageSection } from "../renderer/settings/SettingsCredentialStorageSection";
import { SettingsSecuritySection } from "../renderer/settings/SettingsSecuritySection";

const { credentialStorageSettingsBridge } = vi.hoisted(() => ({
  credentialStorageSettingsBridge: {
    getCredentialStorageSettings: vi.fn(),
    configureCredentialStorage: vi.fn()
  }
}));

vi.mock("../renderer/bridge", () => ({ credentialStorageSettingsBridge }));

afterEach(() => {
  cleanup();
  credentialStorageSettingsBridge.getCredentialStorageSettings.mockReset();
  credentialStorageSettingsBridge.configureCredentialStorage.mockReset();
});

describe("credential storage settings view", () => {
  it("presents credential storage as a dedicated security setting", () => {
    credentialStorageSettingsBridge.getCredentialStorageSettings.mockReturnValue(
      new Promise(() => undefined)
    );

    render(<SettingsSecuritySection t={createTranslator("zh-CN")} />);

    expect(screen.getByRole("heading", { name: "安全与凭据", level: 1 })).toBeVisible();
    expect(screen.getByTestId("credential-storage-settings")).toBeVisible();
  });

  it("renders the storage choices before the asynchronous status request resolves", () => {
    credentialStorageSettingsBridge.getCredentialStorageSettings.mockReturnValue(
      new Promise(() => undefined)
    );

    render(<SettingsCredentialStorageSection t={createTranslator("zh-CN")} />);

    expect(screen.getByText("PlanWeave 凭据存储")).toBeVisible();
    expect(screen.getByText(/Agent Host 管理凭据/)).toBeVisible();
    expect(screen.getByTestId("credential-storage-option-application")).toBeVisible();
    expect(screen.getByTestId("credential-storage-option-system")).toBeVisible();
  });

  it("presents app storage as the natural default and applies a one-time choice", async () => {
    credentialStorageSettingsBridge.getCredentialStorageSettings.mockResolvedValue({
      activeMode: "application",
      configuredMode: "application",
      restartRequired: false
    });
    credentialStorageSettingsBridge.configureCredentialStorage.mockResolvedValue({
      activeMode: "application",
      configuredMode: "system",
      restartRequired: true
    });

    render(<SettingsCredentialStorageSection t={createTranslator("zh-CN")} />);

    expect(await screen.findByTestId("credential-storage-option-application")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByText("推荐")).toBeVisible();

    await userEvent.click(screen.getByTestId("credential-storage-option-system"));

    expect(credentialStorageSettingsBridge.configureCredentialStorage).not.toHaveBeenCalled();
    expect(screen.getByTestId("credential-storage-system-confirmation")).toBeVisible();
    await userEvent.click(screen.getByTestId("credential-storage-system-confirm"));

    expect(credentialStorageSettingsBridge.configureCredentialStorage).toHaveBeenCalledWith({
      mode: "system"
    });
    expect(await screen.findByText(/凭据已迁移/)).toBeVisible();
  });
});
