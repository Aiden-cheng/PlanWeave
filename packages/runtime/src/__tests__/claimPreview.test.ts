import { describe, expect, it } from "vitest";
import { previewClaimNext } from "../desktop/claimPreviewApi.js";
import {
  claimNext,
  getExecutionStatus,
  submitBlockResult,
  submitFeedback,
  submitReviewResult
} from "../taskManager/index.js";
import {
  basicManifest,
  createTestWorkspace,
  writeReport,
  writeReviewResult
} from "./promptTestHelpers.js";

describe("previewClaimNext", () => {
  it("returns the next claimable unit after B-001 completes without mutating status", async () => {
    const { root } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "b.md")
    });

    const statusBefore = await getExecutionStatus({ projectRoot: root });
    const preview = await previewClaimNext(root, null, { kind: "project" });

    expect(preview).toMatchObject({
      kind: "block",
      ref: "T-001#R-001",
      blockType: "review"
    });

    const statusAfter = await getExecutionStatus({ projectRoot: root });
    expect(statusAfter).toEqual(statusBefore);
    expect(statusAfter.blocks.find((block) => block.ref === "T-001#R-001")?.status).toBe("ready");
  });

  it("returns open feedback before any block claim", async () => {
    const { root } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "b.md")
    });
    await claimNext({ projectRoot: root });
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "Please update tests.")
    });

    const statusBefore = await getExecutionStatus({ projectRoot: root });
    const preview = await previewClaimNext(root, null, { kind: "project" });

    expect(preview).toEqual({
      kind: "feedback",
      feedbackId: "FE-001",
      sourceReviewBlockRef: "T-001#R-001",
      taskId: "T-001",
      content: "Please update tests.",
      effectiveExecutor: "default"
    });

    const statusAfter = await getExecutionStatus({ projectRoot: root });
    expect(statusAfter).toEqual(statusBefore);
    expect(statusAfter.openFeedback.find((item) => item.feedbackId === "FE-001")?.status).toBe(
      "open"
    );
  });

  it("dry-run does not claim the initial implementation block", async () => {
    const { root } = await createTestWorkspace(basicManifest());
    const statusBefore = await getExecutionStatus({ projectRoot: root });

    const preview = await previewClaimNext(root, null, { kind: "project" });
    expect(preview).toMatchObject({
      kind: "block",
      ref: "T-001#B-001",
      blockType: "implementation"
    });

    const statusAfter = await getExecutionStatus({ projectRoot: root });
    expect(statusAfter).toEqual(statusBefore);
    expect(statusAfter.blocks.find((block) => block.ref === "T-001#B-001")?.status).toBe("ready");
  });

  it("returns the same review block after feedback is resolved", async () => {
    const { root } = await createTestWorkspace();
    await claimNext({ projectRoot: root });
    await submitBlockResult({
      projectRoot: root,
      ref: "T-001#B-001",
      reportPath: await writeReport(root, "b.md")
    });
    await claimNext({ projectRoot: root });
    await submitReviewResult({
      projectRoot: root,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "Please update tests.")
    });
    await claimNext({ projectRoot: root });
    await submitFeedback({
      projectRoot: root,
      reportPath: await writeReport(root, "feedback.md", "Tests updated.\n")
    });

    const statusBefore = await getExecutionStatus({ projectRoot: root });
    const preview = await previewClaimNext(root, null, { kind: "project" });
    expect(preview).toMatchObject({
      kind: "block",
      ref: "T-001#R-001",
      blockType: "review",
      reason: "feedback_resolved"
    });
    const statusAfter = await getExecutionStatus({ projectRoot: root });
    expect(statusAfter).toEqual(statusBefore);
    expect(statusAfter.blocks.find((block) => block.ref === "T-001#R-001")?.status).toBe(
      "in_progress"
    );
  });
});
