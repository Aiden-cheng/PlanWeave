/* @vitest-environment jsdom */

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { createTranslator } from "../renderer/i18n";
import { useSharedCanvasCommands } from "../renderer/hooks/useSharedCanvasCommands";

afterEach(cleanupRendererTestEnvironment);

describe("useSharedCanvasCommands", () => {
  it("keeps the command facade stable when its inputs and snapshot are unchanged", () => {
    const t = createTranslator("en");
    const { result, rerender } = renderHook(() =>
      useSharedCanvasCommands({
        api: null,
        enabled: false,
        canvasId: null,
        profileId: null,
        selectedProjectId: null,
        activeProjectId: null,
        t
      })
    );
    const initialFacade = result.current;

    rerender();

    expect(result.current).toBe(initialFacade);
  });
});
