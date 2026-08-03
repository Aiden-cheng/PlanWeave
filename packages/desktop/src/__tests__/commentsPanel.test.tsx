/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../renderer/i18n";
import { CommentsPanel } from "../renderer/team/CommentsPanel";
import { ActivityPanel } from "../renderer/team/ActivityPanel";
import type { CommentRowViewModel } from "../renderer/collaboration/commentViewModels";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const t = createTranslator("en");

const liveRow: CommentRowViewModel = {
  commentId: "comment-1",
  authorLabel: "Ada",
  authorActive: true,
  isCurrentUser: true,
  body: "Hello **team**\n\n<script>alert(1)</script>",
  bodyFormat: "markdown",
  revision: 1,
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:00.000Z",
  tombstoned: false,
  tombstoneLabel: null,
  workItemMissing: false,
  attachments: [
    {
      id: "a".repeat(64),
      displayName: "notes.txt",
      mediaType: "text/plain",
      sizeBytes: 4,
      digestShort: "aaaaaaaa…"
    }
  ],
  actions: { canEdit: true, canTombstone: true, reason: "author" }
};

afterEach(() => {
  cleanupRendererTestEnvironment();
  vi.restoreAllMocks();
});

describe("CommentsPanel", () => {
  it("renders active comments without exposing removed tombstones", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn().mockResolvedValue(true);
    const onTombstone = vi.fn().mockResolvedValue(true);
    const onSubmit = vi.fn().mockResolvedValue(true);
    const onDraftBodyChange = vi.fn();

    render(
      <CommentsPanel
        mode="ready"
        rows={[liveRow]}
        draft={{ body: "draft body", showPreview: false }}
        stagedAttachments={[]}
        loading={false}
        loadingMore={false}
        hasMore
        submitting={false}
        actionError={null}
        canCompose
        t={t}
        onDraftBodyChange={onDraftBodyChange}
        onShowPreviewChange={vi.fn()}
        onLoadMore={vi.fn().mockResolvedValue(undefined)}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        onSubmit={onSubmit}
        onEdit={onEdit}
        onTombstone={onTombstone}
        onStageFiles={vi.fn().mockResolvedValue(undefined)}
        onCancelAttachment={vi.fn()}
        onRemoveAttachment={vi.fn()}
      />
    );

    expect(screen.getByTestId("comments-panel")).toHaveAttribute("data-mode", "ready");
    expect(screen.getByText("Comments")).toBeInTheDocument();
    expect(screen.queryByTestId("comments-item-tombstone")).toBeNull();
    expect(screen.queryByText("This comment was removed.")).toBeNull();
    // SafeMarkdown renders text nodes; script tags are not executable DOM.
    expect(screen.getByTestId("comments-item-body").textContent).toContain("<script>");
    expect(screen.queryByTestId("comments-item-body")?.querySelector("script")).toBeNull();
    expect(screen.getByTestId("comments-attachment")).toHaveTextContent("notes.txt");
    expect(screen.getByTestId("comments-load-more")).toBeInTheDocument();

    await user.click(screen.getByTestId("comments-edit"));
    await user.clear(screen.getByLabelText(t("commentsEditAria")));
    await user.type(screen.getByLabelText(t("commentsEditAria")), "updated");
    await user.click(screen.getByTestId("comments-edit-save"));
    expect(onEdit).toHaveBeenCalledWith("comment-1", "updated", 1);

    vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(screen.getAllByTestId("comments-tombstone")[0]!);
    expect(onTombstone).toHaveBeenCalledWith("comment-1", 1);

    await user.click(screen.getByTestId("comments-submit"));
    expect(onSubmit).toHaveBeenCalled();
  });

  it("exposes load-more, retry, and attachment cancel controls", async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn().mockResolvedValue(undefined);
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();

    render(
      <CommentsPanel
        mode="error"
        rows={[]}
        draft={{ body: "", showPreview: false }}
        stagedAttachments={[
          {
            localId: "local-1",
            displayName: "a.png",
            mediaType: "image/png",
            sizeBytes: 10,
            phase: "uploading",
            progress: 0.4,
            errorMessage: null,
            pendingUploadId: "pending-1",
            digestSha256: null,
            input: null
          }
        ]}
        loading={false}
        loadingMore={false}
        hasMore
        submitting={false}
        actionError="offline"
        canCompose
        t={t}
        onDraftBodyChange={vi.fn()}
        onShowPreviewChange={vi.fn()}
        onLoadMore={onLoadMore}
        onRefresh={onRefresh}
        onSubmit={vi.fn().mockResolvedValue(false)}
        onEdit={vi.fn().mockResolvedValue(false)}
        onTombstone={vi.fn().mockResolvedValue(false)}
        onStageFiles={vi.fn().mockResolvedValue(undefined)}
        onCancelAttachment={onCancel}
        onRemoveAttachment={vi.fn()}
      />
    );

    await user.click(screen.getByTestId("comments-retry"));
    expect(onRefresh).toHaveBeenCalled();
    await user.click(screen.getByTestId("comments-load-more"));
    expect(onLoadMore).toHaveBeenCalled();
    await user.click(screen.getByTestId("comments-cancel-attachment"));
    expect(onCancel).toHaveBeenCalledWith("local-1");
    expect(screen.getByTestId("comments-staged-attachment")).toHaveAttribute(
      "data-phase",
      "uploading"
    );
  });
});

describe("ActivityPanel", () => {
  it("renders typed sources without interactive command affordances", () => {
    render(
      <ActivityPanel
        mode="ready"
        rows={[
          {
            activityId: "a1",
            type: "assignment_updated",
            sourceKind: "assignment",
            sourceLabelKey: "activitySourceAssignment",
            headline: "Assigned to Ada",
            occurredAt: "2030-01-01T00:00:00.000Z",
            workItemLabel: "Task T-1",
            interactive: false
          },
          {
            activityId: "a2",
            type: "remote_run_succeeded",
            sourceKind: "remote_run",
            sourceLabelKey: "activitySourceRemoteRun",
            headline: "Remote run succeeded",
            occurredAt: "2030-01-01T00:01:00.000Z",
            workItemLabel: "Block T-1#B-001",
            interactive: false
          }
        ]}
        loading={false}
        loadingMore={false}
        hasMore={false}
        actionError={null}
        t={t}
        onLoadMore={vi.fn().mockResolvedValue(undefined)}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const items = screen.getAllByTestId("activity-item");
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item).toHaveAttribute("data-interactive", "false");
      expect(within(item).queryByRole("button")).toBeNull();
    }
    expect(screen.getAllByTestId("activity-source")[0]).toHaveTextContent("Assignment");
    expect(screen.getAllByTestId("activity-source")[1]).toHaveTextContent("Remote run");
  });
});
