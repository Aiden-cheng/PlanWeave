/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopAgentDetection,
  DesktopBlockDetail,
  DesktopBlockRunRecordSummary,
  DesktopGraphViewModel
} from "@planweave-ai/runtime";
import { BlockInspector } from "../renderer/inspector/BlockInspector";
import { createTranslator } from "../renderer/i18n";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

const remoteRunPanelPropsSpy = vi.fn();

vi.mock("../renderer/team/RemoteRunPanel", () => ({
  RemoteRunPanel: (props: {
    agentEndpoints?: Array<{
      id: string;
      source: "local" | "remote";
      displayName: string;
      locationName: string;
    }>;
    localAutoRunActive?: boolean;
    localAgentEndpoints?: Array<{
      executorName: string;
      available: boolean;
      capabilities: string[];
    }>;
    requiredProfileId?: string | null;
    requiredAgentId?: string | null;
    onAgentEndpointChange?: (endpointId: string) => void;
    selectedAgentEndpointId?: string | null;
    workItem: { blockRef?: string } | null;
  }) => {
    remoteRunPanelPropsSpy(props);
    return (
      <div
        data-testid="remote-run-panel-mock"
        data-local-auto-run-active={String(Boolean(props.localAutoRunActive))}
      >
        <label>
          Agent Endpoint
          <select
            aria-label="Agent Endpoint"
            onChange={(event) => props.onAgentEndpointChange?.(event.target.value)}
            value={props.selectedAgentEndpointId ?? ""}
          >
            {(props.agentEndpoints ?? []).map((endpoint) => (
              <option key={endpoint.id} value={endpoint.id}>
                {endpoint.source === "remote"
                  ? `${endpoint.displayName} · ${endpoint.locationName}`
                  : endpoint.displayName}
              </option>
            ))}
            {!props.agentEndpoints
              ? props.localAgentEndpoints?.map((endpoint) => (
                  <option key={endpoint.executorName} value={`local:${endpoint.executorName}`}>
                    {endpoint.executorName}
                  </option>
                ))
              : null}
          </select>
        </label>
      </div>
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

function selectedBlock(patch: Partial<DesktopBlockDetail> = {}): DesktopBlockDetail {
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
    remoteExecution: null,
    ...patch
  };
}

function graphWithProfileBindings(): DesktopGraphViewModel {
  return {
    projectId: "P-001",
    projectTitle: "Project",
    graphVersion: "pgv-test",
    packageFingerprint: "pkg-test",
    executorOptions: ["codex"],
    executorProfileBindings: [
      { name: "codex", agentId: "codex", runnerKind: "cli" },
      { name: "codex-acp", agentId: "codex", runnerKind: "acp" }
    ],
    agentTransport: "cli",
    autoRunPreflightExecutorHint: "codex",
    tasks: [],
    edges: [],
    sharedResourceGroups: [],
    diagnostics: [],
    dirtyPromptRefs: []
  };
}

function codexDetection(runnerKind: "cli" | "acp", installed: boolean): DesktopAgentDetection {
  return {
    kind: "codex",
    runnerKind,
    name: "Codex",
    command: runnerKind === "acp" ? "codex-acp" : "codex",
    versionArgs: ["--version"],
    execArgs: runnerKind === "acp" ? [] : ["exec", "-"],
    fullAccessArgs: [],
    installed,
    version: installed ? "1.0.0" : null,
    unavailableReason: installed ? null : "not found"
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
  it("consumes the shared local and remote Endpoint catalog with distinct IDs", () => {
    const onAgentEndpointChange = vi.fn();
    render(
      <BlockInspector
        agentEndpoints={[
          {
            id: "local:codex",
            source: "local",
            executorName: "codex",
            displayName: "Codex",
            locationName: "",
            capabilities: [],
            available: true,
            unavailableReason: null,
            localExecutorName: "codex"
          },
          {
            id: "remote:codex-windows",
            source: "remote",
            executorName: "codex",
            displayName: "Codex",
            locationName: "LINANIML",
            capabilities: [],
            available: true,
            unavailableReason: null,
            remoteEndpointId: "codex-windows"
          }
        ]}
        blockFeedbackRecords={[]}
        blockReviewAttempts={[]}
        blockRunRecords={[]}
        error={null}
        executorOptions={["codex"]}
        graph={null}
        handleOpenRunRecord={vi.fn()}
        onAgentEndpointChange={onAgentEndpointChange}
        onBlockSelect={vi.fn()}
        onClose={vi.fn()}
        saveSelectedBlockPrompt={vi.fn()}
        saveSelectedBlockTitle={vi.fn()}
        selectedAgentEndpointId="local:codex"
        selectedBlock={selectedBlock({ executor: "codex" })}
        selectedRunRecord={null}
        setSelectedBlock={vi.fn()}
        setSelectedRunRecord={vi.fn()}
        t={createTranslator("en")}
      />
    );

    const selector = screen.getByRole("combobox", { name: "Agent Endpoint" });
    expect(screen.getByRole("option", { name: "Codex" })).toHaveValue("local:codex");
    expect(screen.getByRole("option", { name: "Codex · LINANIML" })).toHaveValue(
      "remote:codex-windows"
    );
    fireEvent.change(selector, { target: { value: "remote:codex-windows" } });
    expect(onAgentEndpointChange).toHaveBeenCalledWith("remote:codex-windows");
    expect(remoteRunPanelPropsSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agentEndpoints: expect.arrayContaining([
          expect.objectContaining({ id: "local:codex" }),
          expect.objectContaining({ id: "remote:codex-windows" })
        ])
      })
    );
  });

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
      expect.objectContaining({
        localAutoRunActive: true,
        localAgentEndpoints: [expect.objectContaining({ executorName: "codex" })],
        requiredProfileId: "codex",
        requiredAgentId: "codex"
      })
    );
    expect(screen.getByRole("combobox", { name: "Agent Endpoint" })).toBeInTheDocument();
    expect(screen.getByTestId("block-task-configuration")).not.toHaveAttribute("open");
    expect(
      screen.getByTestId("block-task-configuration").querySelector('[aria-label="Agent Endpoint"]')
    ).toBeNull();
    expect(screen.getByText("Task configuration")).toBeInTheDocument();
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

  it.each([
    {
      name: "does not use installed CLI evidence for an unavailable ACP profile",
      detections: [codexDetection("cli", true), codexDetection("acp", false)],
      available: false,
      capabilities: []
    },
    {
      name: "uses installed ACP evidence even when the graph-wide transport is CLI",
      detections: [codexDetection("cli", false), codexDetection("acp", true)],
      available: true,
      capabilities: ["acp.codex"]
    }
  ])("binds Endpoint availability to the exact executor profile: $name", ({
    detections,
    available,
    capabilities
  }) => {
    render(
      <BlockInspector
        agentDetections={detections}
        agentTransport="cli"
        blockFeedbackRecords={[]}
        blockReviewAttempts={[]}
        blockRunRecords={[]}
        error={null}
        executorOptions={["codex"]}
        graph={graphWithProfileBindings()}
        handleOpenRunRecord={vi.fn()}
        onBlockSelect={vi.fn()}
        onClose={vi.fn()}
        saveSelectedBlockPrompt={vi.fn()}
        saveSelectedBlockTitle={vi.fn()}
        selectedBlock={selectedBlock({
          executor: "codex-acp",
          effectiveExecutor: "codex-acp"
        })}
        selectedRunRecord={null}
        setSelectedBlock={vi.fn()}
        setSelectedRunRecord={vi.fn()}
        t={createTranslator("en")}
      />
    );

    expect(remoteRunPanelPropsSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        localAgentEndpoints: [
          expect.objectContaining({
            executorName: "codex-acp",
            available,
            capabilities
          })
        ],
        requiredProfileId: "codex-acp",
        requiredAgentId: "codex"
      })
    );
  });
});
