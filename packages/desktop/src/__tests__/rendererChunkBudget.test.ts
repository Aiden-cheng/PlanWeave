import { describe, expect, it } from "vitest";
import {
  appSettingsRouteModuleId,
  maxRendererEntryChunkBytes,
  maxRendererChunkBytes,
  maxSettingsRouteChunkBytes,
  rendererChunkBudgetViolations,
  type RendererChunk
} from "../../vite.config";

function chunk(patch: Partial<RendererChunk> = {}): RendererChunk {
  return {
    type: "chunk",
    code: "export {};",
    facadeModuleId: null,
    fileName: "assets/index-test.js",
    isEntry: false,
    modules: {},
    ...patch
  };
}

describe("renderer chunk budget", () => {
  it("accepts one independent AppSettingsRoute chunk within both budgets", () => {
    expect(
      rendererChunkBudgetViolations([
        chunk({ fileName: "assets/index-test.js", isEntry: true }),
        chunk({
          facadeModuleId: appSettingsRouteModuleId,
          fileName: "assets/settings-test.js",
          modules: { [appSettingsRouteModuleId]: {} }
        })
      ])
    ).toEqual([]);
  });

  it("fails closed when the AppSettingsRoute chunk is missing, duplicated, or becomes the entry", () => {
    expect(rendererChunkBudgetViolations([chunk({ isEntry: true })])).toContain(
      "Expected exactly one AppSettingsRoute chunk, found 0."
    );
    expect(
      rendererChunkBudgetViolations([
        chunk({ facadeModuleId: appSettingsRouteModuleId }),
        chunk({ modules: { [appSettingsRouteModuleId]: {} } })
      ])
    ).toContain("Expected exactly one AppSettingsRoute chunk, found 2.");
    expect(
      rendererChunkBudgetViolations([
        chunk({
          isEntry: true,
          modules: { [appSettingsRouteModuleId]: {} }
        })
      ])
    ).toContain("AppSettingsRoute must be emitted as a non-entry chunk.");
  });

  it("fails closed when a renderer or AppSettingsRoute chunk exceeds its budget", () => {
    expect(
      rendererChunkBudgetViolations([
        chunk({
          code: "x".repeat(maxRendererChunkBytes + 1),
          isEntry: true
        }),
        chunk({
          code: "x".repeat(maxSettingsRouteChunkBytes + 1),
          facadeModuleId: appSettingsRouteModuleId
        })
      ])
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("exceeds the renderer chunk budget"),
        expect.stringContaining("exceeds the AppSettingsRoute budget")
      ])
    );
  });

  it("enforces a stricter budget for the renderer entry chunk", () => {
    expect(
      rendererChunkBudgetViolations([
        chunk({
          code: "x".repeat(maxRendererEntryChunkBytes + 1),
          fileName: "assets/index-test.js",
          isEntry: true
        }),
        chunk({
          facadeModuleId: appSettingsRouteModuleId,
          fileName: "assets/settings-test.js"
        })
      ])
    ).toEqual([
      `assets/index-test.js (${maxRendererEntryChunkBytes + 1} bytes) exceeds the renderer entry chunk budget.`
    ]);
  });
});
