import { useCallback, useEffect, useMemo, useRef } from "react";
import type { CSSProperties, Dispatch, SetStateAction } from "react";
import type {
  DesktopAgentDetection,
  DesktopBlockPreview,
  DesktopCanvasReference,
  DesktopGraphViewModel,
  DesktopTaskDetail,
  RunnerTransport
} from "@planweave-ai/runtime";
import { RefreshCwIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { buildExecutorOptionViews, executorOptionName } from "../executors/executorOptionViewModel";
import { useExecutorPreflight } from "../hooks/useExecutorPreflight";
import type { createTranslator } from "../i18n";
import { AssigneeInspectorField } from "../team/AssigneeInspectorField";
import { WorkItemCollaborationPanel } from "../team/WorkItemCollaborationPanel";
import { statusVariant } from "../viewHelpers";

type TaskInspectorProps = {
  canvasRef?: DesktopCanvasReference | null;
  className?: string;
  error: string | null;
  agentDetections?: DesktopAgentDetection[];
  agentTransport?: RunnerTransport;
  executorOptions: string[];
  graph: DesktopGraphViewModel | null;
  onClose: () => void;
  onDraftDirtyChange?: (dirty: boolean) => void;
  saveSelectedTaskExecutor: (executorName: string | null) => Promise<void>;
  saveSelectedTaskPrompt: () => Promise<void>;
  saveSelectedTaskTitle: () => Promise<void>;
  selectedTask: DesktopTaskDetail | null;
  setSelectedTask: Dispatch<SetStateAction<DesktopTaskDetail | null>>;
  style?: CSSProperties;
  t: ReturnType<typeof createTranslator>;
};

const taskPromptAutosaveDelayMs = 700;

function selectedTaskExecutorValue(
  selectedTask: DesktopTaskDetail | null,
  taskBlocks: DesktopBlockPreview[],
  packageExecutorNames: readonly string[]
): string {
  if (!selectedTask) {
    return "";
  }
  const blockExecutors = new Set(
    taskBlocks
      .map((block) => block.executor)
      .filter((executor): executor is string => executor !== null)
  );
  if (blockExecutors.size > 1) {
    return "__custom";
  }
  return executorOptionName(
    [...blockExecutors][0] ?? selectedTask.executor ?? "manual",
    packageExecutorNames
  );
}

function taskPreflightExecutorValue(
  selectedTask: DesktopTaskDetail | null,
  taskBlocks: DesktopBlockPreview[]
): string | null {
  if (!selectedTask) {
    return null;
  }
  const blockExecutors = new Set(
    taskBlocks
      .map((block) => block.executor)
      .filter((executor): executor is string => executor !== null)
  );
  if (blockExecutors.size === 1) {
    const executor = [...blockExecutors][0] ?? null;
    return executor;
  }
  if (blockExecutors.size > 1) {
    return null;
  }
  return selectedTask.executor;
}

export function TaskInspector({
  agentDetections = [],
  agentTransport,
  canvasRef,
  className,
  error,
  executorOptions,
  graph,
  onClose,
  onDraftDirtyChange,
  saveSelectedTaskExecutor,
  saveSelectedTaskPrompt,
  saveSelectedTaskTitle,
  selectedTask,
  setSelectedTask,
  style,
  t
}: TaskInspectorProps) {
  const taskPromptBaselineRef = useRef<{ promptMarkdown: string; taskId: string } | null>(null);
  const taskBlocks: DesktopBlockPreview[] = useMemo(() => {
    if (!graph || !selectedTask) {
      return [];
    }
    return graph.tasks.find((task) => task.taskId === selectedTask.taskId)?.blocks ?? [];
  }, [graph, selectedTask]);
  const taskExecutionBlocks = useMemo(
    () =>
      taskBlocks.map((block) => ({
        workItem: {
          kind: "block" as const,
          canvasId: canvasRef?.canvasId ?? "default",
          blockRef: block.ref
        },
        dispatchable: block.dispatchable
      })),
    [canvasRef?.canvasId, taskBlocks]
  );
  const selectedExecutor = selectedTaskExecutorValue(
    selectedTask,
    taskBlocks,
    graph?.packageExecutorNames ?? []
  );
  const concreteExecutor = taskPreflightExecutorValue(selectedTask, taskBlocks);
  const taskExecutorOptions = buildExecutorOptionViews({
    agentDetections,
    agentTransport: agentTransport ?? graph?.agentTransport,
    literalExecutorNames: graph?.packageExecutorNames,
    currentExecutorNames:
      selectedExecutor !== "__custom" && selectedExecutor ? [selectedExecutor] : [],
    executorOptions
  });
  const preflight = useExecutorPreflight({
    bridgeUnavailableMessage: t("bridgeUnavailable"),
    cacheKey: graph ? `${graph.graphVersion}:${graph.packageFingerprint}` : null,
    canvasRef: canvasRef ?? null,
    executorName: concreteExecutor
  });

  useEffect(() => {
    if (!selectedTask) {
      taskPromptBaselineRef.current = null;
      onDraftDirtyChange?.(false);
      return;
    }
    if (taskPromptBaselineRef.current?.taskId !== selectedTask.taskId) {
      taskPromptBaselineRef.current = {
        promptMarkdown: selectedTask.promptMarkdown,
        taskId: selectedTask.taskId
      };
      onDraftDirtyChange?.(false);
      return;
    }
    onDraftDirtyChange?.(
      taskPromptBaselineRef.current.promptMarkdown !== selectedTask.promptMarkdown
    );
  }, [onDraftDirtyChange, selectedTask]);

  const saveTaskPromptIfDirty = useCallback(() => {
    if (!selectedTask) {
      return;
    }
    const baseline = taskPromptBaselineRef.current;
    if (
      !baseline ||
      baseline.taskId !== selectedTask.taskId ||
      baseline.promptMarkdown === selectedTask.promptMarkdown
    ) {
      return;
    }
    taskPromptBaselineRef.current = {
      promptMarkdown: selectedTask.promptMarkdown,
      taskId: selectedTask.taskId
    };
    onDraftDirtyChange?.(false);
    void saveSelectedTaskPrompt();
  }, [onDraftDirtyChange, saveSelectedTaskPrompt, selectedTask]);

  useEffect(() => {
    if (!selectedTask) {
      return undefined;
    }
    const baseline = taskPromptBaselineRef.current;
    if (
      !baseline ||
      baseline.taskId !== selectedTask.taskId ||
      baseline.promptMarkdown === selectedTask.promptMarkdown
    ) {
      return undefined;
    }
    const timer = window.setTimeout(saveTaskPromptIfDirty, taskPromptAutosaveDelayMs);
    return () => window.clearTimeout(timer);
  }, [saveTaskPromptIfDirty, selectedTask]);

  if (!selectedTask && !error) {
    return null;
  }

  return (
    <Card
      className={cn(
        "flex min-h-[420px] min-w-[380px] flex-col overflow-hidden bg-background shadow-xl",
        className
      )}
      size="sm"
      style={style}
    >
      <CardHeader className="border-b px-5 py-4">
        <CardTitle className="min-w-0">
          {selectedTask ? (
            <Input
              aria-label={t("title")}
              className="h-8 min-w-0 border-transparent bg-transparent px-0 text-lg font-semibold shadow-none focus-visible:border-transparent focus-visible:ring-0"
              value={selectedTask.title}
              onBlur={() => void saveSelectedTaskTitle().then(() => onDraftDirtyChange?.(false))}
              onChange={(event) => {
                onDraftDirtyChange?.(true);
                setSelectedTask({ ...selectedTask, title: event.target.value });
              }}
            />
          ) : (
            t("selectedTask")
          )}
        </CardTitle>
        {selectedTask ? (
          <CardDescription className="font-mono text-xs">{selectedTask.taskId}</CardDescription>
        ) : null}
        <CardAction className="flex items-center gap-1">
          {selectedTask ? (
            <Badge variant={statusVariant[selectedTask.status]}>{selectedTask.status}</Badge>
          ) : null}
          <Button size="icon-sm" variant="ghost" aria-label={t("close")} onClick={onClose}>
            <XIcon data-icon="inline-start" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-5 py-4">
        {selectedTask ? (
          <div className="flex min-h-0 flex-1 flex-col gap-5">
            <div className="flex flex-col gap-1">
              <div className="text-xs font-medium text-muted-foreground">{t("agent")}</div>
              <Select
                value={selectedExecutor}
                onValueChange={(value) => void saveSelectedTaskExecutor(value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {selectedExecutor === "__custom" ? (
                      <SelectItem value="__custom" disabled>
                        {t("customExecutor")}
                      </SelectItem>
                    ) : null}
                    {taskExecutorOptions.map((executor) => (
                      <SelectItem
                        disabled={executor.disabled}
                        value={executor.name}
                        key={executor.name}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span>{executor.label}</span>
                          {executor.custom ? (
                            <span className="text-xs text-muted-foreground">
                              {t("customExecutor")}
                            </span>
                          ) : null}
                          {executor.disabled ? (
                            <span className="text-xs text-muted-foreground">
                              {t("unavailable")}
                            </span>
                          ) : null}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <div className="flex min-h-7 items-center gap-2 text-xs text-muted-foreground">
                {!concreteExecutor ? (
                  <span>{t("executorPreflightSelectConcrete")}</span>
                ) : preflight.result ? (
                  <Badge
                    data-testid="task-executor-preflight-status"
                    variant={preflight.result.ok ? "secondary" : "destructive"}
                  >
                    {preflight.result.ok ? t("preflightPassed") : t("preflightFailed")}
                  </Badge>
                ) : preflight.error ? (
                  <span className="min-w-0 truncate text-destructive">{preflight.error}</span>
                ) : (
                  <span>{t("executorPreflightNotRun")}</span>
                )}
                <Button
                  data-testid="task-executor-preflight"
                  disabled={!canvasRef || !concreteExecutor || preflight.loading}
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("runPreflight")}
                  title={t("runPreflight")}
                  onClick={() => void preflight.runPreflight()}
                >
                  <RefreshCwIcon
                    className={preflight.loading ? "animate-spin" : undefined}
                    data-icon="inline-start"
                  />
                </Button>
              </div>
            </div>
            <AssigneeInspectorField
              workItem={
                selectedTask
                  ? {
                      kind: "task",
                      canvasId: canvasRef?.canvasId ?? "default",
                      taskId: selectedTask.taskId
                    }
                  : null
              }
              taskExecutionBlocks={taskExecutionBlocks}
              t={t}
            />
            <section className="border-t border-border/80 pt-4 text-xs">
              <div className="text-sm font-semibold">{t("taskExecutionSummary")}</div>
              {selectedTask.acceptance.length > 0 ? (
                <div className="mt-3 flex flex-col gap-2">
                  <div className="font-medium">{t("acceptanceCriteria")}</div>
                  {selectedTask.acceptance.map((item) => (
                    <div
                      className="border-b border-border/60 pb-2 text-muted-foreground"
                      key={item}
                    >
                      {item}
                    </div>
                  ))}
                </div>
              ) : null}
              {taskBlocks.length > 0 ? (
                <div className="mt-3 flex flex-col gap-1">
                  <div className="font-medium">{t("blockStack")}</div>
                  {taskBlocks.map((block) => (
                    <div
                      className="flex items-center justify-between gap-2 border-b border-border/60 py-2"
                      key={block.ref}
                    >
                      <span className="min-w-0 truncate">{block.title}</span>
                      <Badge variant={statusVariant[block.status]}>{block.status}</Badge>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
            <section className="flex flex-col gap-2 border-t border-border/80 pt-4">
              <div className="text-sm font-semibold">{t("taskPrompt")}</div>
              <Textarea
                aria-label={t("taskPrompt")}
                className="min-h-56 resize-y"
                value={selectedTask.promptMarkdown}
                onBlur={saveTaskPromptIfDirty}
                onChange={(event) => {
                  onDraftDirtyChange?.(true);
                  setSelectedTask({ ...selectedTask, promptMarkdown: event.target.value });
                }}
              />
            </section>
            <WorkItemCollaborationPanel
              workItem={{
                kind: "task",
                canvasId: canvasRef?.canvasId ?? "default",
                taskId: selectedTask.taskId
              }}
              t={t}
            />
          </div>
        ) : (
          <div className="text-sm text-muted-foreground">{t("tasks")}</div>
        )}
      </CardContent>
      {error ? (
        <>
          <Separator />
          <CardContent>
            <Badge variant="destructive">{error}</Badge>
          </CardContent>
        </>
      ) : null}
    </Card>
  );
}
