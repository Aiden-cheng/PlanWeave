export const COLLABORATION_REFRESH_MAX_PAGES = 20;
export const COLLABORATION_REFRESH_MAX_ITEMS = 1_000;

type NumberCursorPage<T> = {
  items: T[];
  nextCursor: number | null;
};

type BoundedPaginationResource = "members" | "assignments";

function paginationError(
  resource: BoundedPaginationResource,
  reason: "cursor_repeated" | "item_limit_exceeded" | "page_limit_exceeded"
): Error & { kind: string; code: string; retryable: false } {
  return Object.assign(new Error(`Collaboration ${resource} pagination failed: ${reason}.`), {
    kind: "protocol",
    code: `collaboration_${resource}_pagination_${reason}`,
    retryable: false as const
  });
}

/**
 * Exhausts an opaque numeric cursor without interpreting its ordering. The result is returned only
 * after the terminal page, so callers can preserve their previous authoritative snapshot on error.
 */
export async function readBoundedNumberCursorPages<T>(input: {
  resource: BoundedPaginationResource;
  readPage(cursor: number): Promise<NumberCursorPage<T>>;
}): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<number>([0]);
  let cursor = 0;

  for (let pageCount = 1; pageCount <= COLLABORATION_REFRESH_MAX_PAGES; pageCount += 1) {
    const page = await input.readPage(cursor);
    if (items.length + page.items.length > COLLABORATION_REFRESH_MAX_ITEMS) {
      throw paginationError(input.resource, "item_limit_exceeded");
    }
    items.push(...page.items);

    if (page.nextCursor === null) return items;
    if (seenCursors.has(page.nextCursor)) {
      throw paginationError(input.resource, "cursor_repeated");
    }
    if (pageCount === COLLABORATION_REFRESH_MAX_PAGES) {
      throw paginationError(input.resource, "page_limit_exceeded");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  throw paginationError(input.resource, "page_limit_exceeded");
}
