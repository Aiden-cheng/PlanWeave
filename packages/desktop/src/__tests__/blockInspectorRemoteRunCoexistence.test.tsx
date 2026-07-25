/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopBlockDetail, DesktopBlockRunRecordSummary } from "@planweave-ai/runtime";
import { BlockInspector } from "../renderer/inspector/BlockInspector";
import { createTranslator } from "../renderer/i18n";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const remoteRunPanelPropsSpy = vi.fn();

vi.mock("../renderer/team/RemoteRunPanel", () => ({
  RemoteRunPanel: (props: {
    localAutoRunActive?: boolean;
    workItem: { blockRef?: string } | null;
  }) => {
    remoteRunPanelPropsSpy(props);
    return (
      <div
        data-testid="remote-run-panel-mock"
        data-local-auto-run-active={String(Boolean(props.localAutoRunActive))}
      />
    );
  }
}));

vi.mock("../renderer/team/WorkItemCollaborationPanel", () => ({
  WorkItemCollaborationPanel: () => null
}));

vi.mock("../renderer/team/AssigneeInspectorField", () => ({
  AssigneeInspectorField: () => null
}));

afterEach(() => {
  cleanupRendererTestEnvironment();
  remoteRunPanelPropsSpy.mockClear();
});

function selectedBlock(): DesktopBlockDetail {
  return {
    ref: "T-001#B-001",
    taskId: "T-001",
    blockId: "B-001",
    type: "implementation",
    title: "Implement task",
    status: "in_progress",
    executor: null,
    effectiveExecutor: "codex",
    promptMarkdown: "# Implement",
    promptMissing: false,
    promptSurfaceMarkdown: "# Effective",
    promptSources: [],
    dependencies: [],
    latestRunId: "run-1",
    latestReviewAttemptId: null,
    activeFeedbackId: null,
    exceptionReason: null,
    reviewGate: null,
    remoteExecution: null
  };
}

function unfinishedRecord(): DesktopBlockRunRecordSummary {
  return {
    recordId: "T-001#B-001::run-1",
    ref: "T-001#B-001",
    taskId: "T-001",
    blockId: "B-001",
    runId: "run-1",
    executor: "codex",
    adapter: null,
    executionCwd: null,
    projectRoot: null,
    agentSessionId: null,
    codexSessionId: null,
    exitCode: null,
    startedAt: "2030-01-01T00:00:00.000Z",
    finishedAt: null,
    promptPath: null,
    reportPath: null,
    metadataPath: "meta.json",
    stdoutSummary: "",
    stderrSummary: ""
  };
}

describe("BlockInspector remote run coexistence wiring", () => {
  it("passes localAutoRunActive when the selected Block has an unfinished local run", () => {
    render(
      <BlockInspector
        blockFeedbackRecords={[]}
        blockReviewAttempts={[]}
        blockRunRecords={[unfinishedRecord()]}
        error={null}
        executorOptions={["codex"]}
        graph={null}
        handleOpenRunRecord={vi.fn()}
        onBlockSelect={vi.fn()}
        onClose={vi.fn()}
        saveSelectedBlockExecutor={vi.fn()}
        saveSelectedBlockPrompt={vi.fn()}
        saveSelectedBlockTitle={vi.fn()}
        selectedBlock={selectedBlock()}
        selectedRunRecord={null}
        setSelectedBlock={vi.fn()}
        setSelectedRunRecord={vi.fn()}
        t={createTranslator("en")}
      />
    );

    expect(screen.getByTestId("remote-run-panel-mock")).toHaveAttribute(
      "data-local-auto-run-active",
      "true"
    );
    expect(remoteRunPanelPropsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ localAutoRunActive: true })
    );
  });

  it("does not mark local Auto Run active when all block run records are finished", () => {
    render(
      <BlockInspector
        blockFeedbackRecords={[]}
        blockReviewAttempts={[]}
        blockRunRecords={[{ ...unfinishedRecord(), finishedAt: "2030-01-01T01:00:00.000Z" }]}
        error={null}
        executorOptions={["codex"]}
        graph={null}
        handleOpenRunRecord={vi.fn()}
        onBlockSelect={vi.fn()}
        onClose={vi.fn()}
        saveSelectedBlockExecutor={vi.fn()}
        saveSelectedBlockPrompt={vi.fn()}
        saveSelectedBlockTitle={vi.fn()}
        selectedBlock={selectedBlock()}
        selectedRunRecord={null}
        setSelectedBlock={vi.fn()}
        setSelectedRunRecord={vi.fn()}
        t={createTranslator("en")}
      />
    );

    expect(screen.getByTestId("remote-run-panel-mock")).toHaveAttribute(
      "data-local-auto-run-active",
      "false"
    );
  });
});
