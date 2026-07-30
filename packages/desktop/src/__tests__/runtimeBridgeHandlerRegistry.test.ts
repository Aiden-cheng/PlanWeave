import { describe, expect, it } from "vitest";
import { assertDistinctRuntimeBridgeHandlerKeys } from "../main/runtimeBridgeHandlerTypes";

describe("runtime bridge handler registry", () => {
  it("rejects duplicate handler keys before object spread can overwrite one", () => {
    expect(() =>
      assertDistinctRuntimeBridgeHandlerKeys([
        { listProjects: () => undefined },
        { listProjects: () => undefined }
      ])
    ).toThrow("Duplicate runtime bridge handler 'listProjects'.");
  });

  it("accepts disjoint handler groups", () => {
    expect(() =>
      assertDistinctRuntimeBridgeHandlerKeys([
        { listProjects: () => undefined },
        { checkProjectDoctor: () => undefined }
      ])
    ).not.toThrow();
  });
});
