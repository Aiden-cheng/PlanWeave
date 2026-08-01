import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { readAuthorizedCanvasRuntimeStatus } from "../desktop/canvasRuntimeStatus.js";
import { readState, writeState } from "../state.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("authorized canvas runtime status", () => {
  it("returns current task/block statuses without device-private runtime fields", async () => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.home, fixture.root);
    const state = await readState(fixture.init.workspace.stateFile);
    state.blocks["T-001#B-001"] = {
      status: "completed",
      lastRunId: "private-run-id"
    };
    state.blocks["T-001#R-001"] = {
      status: "completed",
      completionReason: "passed",
      lastRunId: "private-review-run-id"
    };
    await writeState(fixture.init.workspace.stateFile, state);

    const projection = await readAuthorizedCanvasRuntimeStatus({
      projectRoot: fixture.root,
      canvasId: "default",
      expectedPackageDir: fixture.init.workspace.packageDir,
      scope: { workspaceId: "w", projectId: "p", canvasId: "default" },
      capturedAt: "2026-08-01T00:00:00.000Z"
    });

    expect(projection.tasks).toContainEqual({
      taskId: "T-001",
      status: "implemented",
      openFeedbackCount: 0
    });
    expect(projection.blocks).toContainEqual({
      ref: "T-001#R-001",
      status: "completed",
      completionReason: "passed",
      blockedReason: null,
      divergenceReason: null
    });
    expect(JSON.stringify(projection)).not.toContain("private-run-id");
  });

  it("rejects a package path outside the authorized canvas", async () => {
    const fixture = await createTestWorkspace();
    directories.push(fixture.home, fixture.root);

    await expect(
      readAuthorizedCanvasRuntimeStatus({
        projectRoot: fixture.root,
        canvasId: "default",
        expectedPackageDir: `${fixture.init.workspace.packageDir}-other`,
        scope: { workspaceId: "w", projectId: "p", canvasId: "default" }
      })
    ).rejects.toThrow("runtime_package_location_mismatch");
  });
});
