import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalCollaborationScopeStore } from "../main/collaboration/LocalCollaborationScopeStore";

describe("LocalCollaborationScopeStore", () => {
  it("persists only validated opaque project and canvas selections", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-local-scopes-"));
    const path = join(root, "collaboration", "local-scopes.json");
    const store = new LocalCollaborationScopeStore(path);
    const scopes = [
      { projectId: "project-a", canvasId: "default" },
      { projectId: "project-a", canvasId: "planning" }
    ];

    expect(await store.read()).toEqual([]);
    await store.write(scopes);

    expect(await new LocalCollaborationScopeStore(path).read()).toEqual(scopes);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, scopes });
  });
});
