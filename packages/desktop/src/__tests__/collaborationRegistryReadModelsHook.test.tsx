// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCollaborationRegistryReadModels } from "../renderer/hooks/useCollaborationRegistryReadModels.js";

describe("useCollaborationRegistryReadModels", () => {
  it("loads project and selected-canvas read models through the typed bridge", async () => {
    const api = {
      listCollaborationAuthorizedProjects: vi.fn(async () => ({ items: [], nextCursor: 3 })),
      listCollaborationAuthorizedCanvases: vi.fn(async () => ({ items: [], nextCursor: 5 }))
    };
    const { result, rerender } = renderHook(
      ({ refreshKey }) =>
        useCollaborationRegistryReadModels({
          api,
          projectId: "project-a",
          projectPage: { cursor: 2, limit: 1 },
          canvasPage: { cursor: 4, limit: 1 },
          refreshKey
        }),
      { initialProps: { refreshKey: 0 } }
    );

    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(api.listCollaborationAuthorizedProjects).toHaveBeenCalledWith({ cursor: 2, limit: 1 });
    expect(api.listCollaborationAuthorizedCanvases).toHaveBeenCalledWith({
      projectId: "project-a",
      cursor: 4,
      limit: 1
    });
    expect(result.current.projects).toEqual([]);
    expect(result.current.canvases).toEqual([]);
    expect(result.current.projectNextCursor).toBe(3);
    expect(result.current.canvasNextCursor).toBe(5);

    rerender({ refreshKey: 0 });
    expect(api.listCollaborationAuthorizedProjects).toHaveBeenCalledTimes(1);
    expect(api.listCollaborationAuthorizedCanvases).toHaveBeenCalledTimes(1);
    rerender({ refreshKey: 1 });
    await waitFor(() => expect(api.listCollaborationAuthorizedProjects).toHaveBeenCalledTimes(2));
    expect(api.listCollaborationAuthorizedCanvases).toHaveBeenCalledTimes(2);
  });

  it("redacts bridge failures to a stable read-model error", async () => {
    const api = {
      listCollaborationAuthorizedProjects: vi.fn(async () => {
        throw new Error("absolute path /srv/private/project");
      }),
      listCollaborationAuthorizedCanvases: vi.fn(async () => ({ items: [], nextCursor: null }))
    };
    const { result } = renderHook(() => useCollaborationRegistryReadModels({ api }));

    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error).toBe("collaboration_registry_read_failed");
    expect(result.current.error).not.toContain("/srv");
  });
});
