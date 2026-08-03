import { useCallback, useEffect, useState } from "react";
import { bridge } from "../bridge";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useGlobalPrompt(setError: (message: string | null) => void, planweaveHome: string) {
  const [globalPromptMarkdown, setGlobalPromptMarkdown] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: changing PlanWeave Home selects a different main-process prompt file.
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    setGlobalPromptMarkdown(null);
    void bridge
      .readGlobalPrompt()
      .then((markdown) => {
        if (!cancelled) setGlobalPromptMarkdown(markdown);
      })
      .catch((error: unknown) => {
        if (!cancelled) setError(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [planweaveHome, setError]);

  const updateGlobalPrompt = useCallback(
    async (markdown: string) => {
      if (!bridge) return;
      try {
        setGlobalPromptMarkdown(await bridge.updateGlobalPrompt(markdown));
      } catch (error) {
        setError(errorMessage(error));
      }
    },
    [setError]
  );

  return { globalPromptMarkdown, updateGlobalPrompt };
}
