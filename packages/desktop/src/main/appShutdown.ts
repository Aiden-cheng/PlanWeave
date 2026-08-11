export type DesktopBeforeQuitEvent = {
  preventDefault(): void;
};

export type DesktopShutdownController = {
  handleBeforeQuit(event: DesktopBeforeQuitEvent): void;
};

export function createDesktopShutdownController(input: {
  closeRendererWindows(): void;
  cleanupTasks: readonly (() => Promise<void>)[];
  reportError(error: unknown): void;
  requestQuit(): void;
}): DesktopShutdownController {
  let cleanupStarted = false;
  let cleanupComplete = false;

  return {
    handleBeforeQuit(event) {
      if (cleanupComplete) return;
      event.preventDefault();
      if (cleanupStarted) return;
      cleanupStarted = true;

      void (async () => {
        try {
          input.closeRendererWindows();
        } catch (error) {
          input.reportError(error);
        }

        const results = await Promise.allSettled(
          input.cleanupTasks.map((task) => Promise.resolve().then(task))
        );
        for (const result of results) {
          if (result.status === "rejected") input.reportError(result.reason);
        }

        cleanupComplete = true;
        input.requestQuit();
      })();
    }
  };
}
