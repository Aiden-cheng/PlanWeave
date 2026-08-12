import { describe, expect, it, vi } from "vitest";
import {
  COLLABORATION_REFRESH_MAX_ITEMS,
  COLLABORATION_REFRESH_MAX_PAGES,
  readBoundedNumberCursorPages
} from "../renderer/collaboration/boundedPagination";

describe("bounded collaboration pagination", () => {
  it("follows opaque cursors through an empty middle page", async () => {
    const readPage = vi
      .fn()
      .mockResolvedValueOnce({ items: ["first"], nextCursor: 41 })
      .mockResolvedValueOnce({ items: [], nextCursor: 7 })
      .mockResolvedValueOnce({ items: ["last"], nextCursor: null });

    await expect(readBoundedNumberCursorPages({ resource: "members", readPage })).resolves.toEqual([
      "first",
      "last"
    ]);
    expect(readPage.mock.calls.map(([cursor]) => cursor)).toEqual([0, 41, 7]);
  });

  it.each([
    "members",
    "assignments"
  ] as const)("rejects a repeated %s cursor instead of looping", async (resource) => {
    const readPage = vi.fn().mockResolvedValue({ items: [], nextCursor: 0 });
    await expect(readBoundedNumberCursorPages({ resource, readPage })).rejects.toMatchObject({
      code: `collaboration_${resource}_pagination_cursor_repeated`
    });
    expect(readPage).toHaveBeenCalledOnce();
  });

  it("rejects page and item overflow with a bounded request count", async () => {
    const pageRead = vi.fn(async (cursor: number) => ({ items: [], nextCursor: cursor + 1 }));
    await expect(
      readBoundedNumberCursorPages({ resource: "assignments", readPage: pageRead })
    ).rejects.toMatchObject({ code: "collaboration_assignments_pagination_page_limit_exceeded" });
    expect(pageRead).toHaveBeenCalledTimes(COLLABORATION_REFRESH_MAX_PAGES);

    const itemRead = vi.fn().mockResolvedValue({
      items: Array.from({ length: COLLABORATION_REFRESH_MAX_ITEMS + 1 }, () => "item"),
      nextCursor: null
    });
    await expect(
      readBoundedNumberCursorPages({ resource: "members", readPage: itemRead })
    ).rejects.toMatchObject({ code: "collaboration_members_pagination_item_limit_exceeded" });
  });

  it("accepts exactly 20 pages and 1000 items", async () => {
    const readPage = vi.fn(async (cursor: number) => ({
      items: Array.from({ length: 50 }, (_, index) => cursor * 50 + index),
      nextCursor: cursor === COLLABORATION_REFRESH_MAX_PAGES - 1 ? null : cursor + 1
    }));
    await expect(
      readBoundedNumberCursorPages({ resource: "assignments", readPage })
    ).resolves.toHaveLength(COLLABORATION_REFRESH_MAX_ITEMS);
    expect(readPage).toHaveBeenCalledTimes(COLLABORATION_REFRESH_MAX_PAGES);
  });

  it("rejects a two-cursor cycle", async () => {
    const readPage = vi.fn(async (cursor: number) => ({
      items: [],
      nextCursor: cursor === 0 ? 9 : 0
    }));
    await expect(
      readBoundedNumberCursorPages({ resource: "members", readPage })
    ).rejects.toMatchObject({ code: "collaboration_members_pagination_cursor_repeated" });
    expect(readPage).toHaveBeenCalledTimes(2);
  });
});
