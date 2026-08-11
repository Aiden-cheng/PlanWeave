import { describe, expect, it, vi } from "vitest";
import { createDesktopShutdownController } from "../main/appShutdown";

describe("Desktop shutdown", () => {
  it("stops renderer windows before collaboration cleanup can dispose its service", async () => {
    const order: string[] = [];
    const preventDefault = vi.fn();
    const requestQuit = vi.fn(() => order.push("quit"));
    const controller = createDesktopShutdownController({
      closeRendererWindows: () => order.push("renderers-closed"),
      cleanupTasks: [
        async () => {
          order.push("collaboration-cleanup");
        }
      ],
      reportError: vi.fn(),
      requestQuit
    });

    controller.handleBeforeQuit({ preventDefault });

    await vi.waitFor(() => expect(requestQuit).toHaveBeenCalledOnce());
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(order).toEqual(["renderers-closed", "collaboration-cleanup", "quit"]);
  });

  it("starts cleanup once and reports failures before completing the quit", async () => {
    let finishCleanup: (() => void) | undefined;
    const cleanupPending = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const expectedError = new Error("cleanup failed");
    const cleanupTask = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(cleanupPending)
      .mockRejectedValueOnce(expectedError);
    const reportError = vi.fn();
    const requestQuit = vi.fn();
    const firstPreventDefault = vi.fn();
    const repeatedPreventDefault = vi.fn();
    const completedPreventDefault = vi.fn();
    const controller = createDesktopShutdownController({
      closeRendererWindows: vi.fn(),
      cleanupTasks: [cleanupTask, cleanupTask],
      reportError,
      requestQuit
    });

    controller.handleBeforeQuit({ preventDefault: firstPreventDefault });
    controller.handleBeforeQuit({ preventDefault: repeatedPreventDefault });
    await vi.waitFor(() => expect(cleanupTask).toHaveBeenCalledTimes(2));
    expect(requestQuit).not.toHaveBeenCalled();

    finishCleanup?.();
    await vi.waitFor(() => expect(requestQuit).toHaveBeenCalledOnce());
    expect(firstPreventDefault).toHaveBeenCalledOnce();
    expect(repeatedPreventDefault).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(expectedError);

    controller.handleBeforeQuit({ preventDefault: completedPreventDefault });
    expect(completedPreventDefault).not.toHaveBeenCalled();
  });
});
