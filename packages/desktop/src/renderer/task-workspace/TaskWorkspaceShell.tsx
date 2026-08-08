import type { TaskWorkspace } from "@planweave-ai/runtime";
import { ArrowLeftIcon } from "lucide-react";
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CompactAssigneeChip } from "../collaboration/assigneeSurfaceViewModels";
import { VerticalResizeHandle } from "../components/VerticalResizeHandle";
import { useElementHeight } from "../hooks/useElementHeight";
import type { TaskWorkspaceLabels } from "./contracts";
import { useInspectorResize } from "./inspector/useInspectorResize";
import { TaskWorkspaceHeader } from "./TaskWorkspaceHeader";
import { useTimelineResize } from "./timeline/useTimelineResize";
import {
  taskWorkspaceConversationMinWidth,
  taskWorkspacePanelMaxWidth,
  taskWorkspacePanelMinWidth,
  type TaskWorkspaceLayout
} from "./useTaskWorkspaceLayout";
import { useTaskWorkspaceReturnShortcut } from "./useTaskWorkspaceReturnShortcut";

interface AnimatedWorkspacePanelProps {
  children: ReactNode;
  collapsed: boolean;
  label: string;
  side: "left" | "right";
  testId?: string;
  width: number;
}

function AnimatedWorkspacePanel({
  children,
  collapsed,
  label,
  side,
  testId,
  width
}: AnimatedWorkspacePanelProps) {
  let interactionClassName = "opacity-100";
  let minimumWidth = taskWorkspacePanelMinWidth;
  let panelWidth = width;
  let inert: true | undefined;
  if (collapsed) {
    interactionClassName = "pointer-events-none opacity-0";
    minimumWidth = 0;
    panelWidth = 0;
    inert = true;
  }

  return (
    <aside
      aria-hidden={collapsed}
      aria-label={label}
      className={cn(
        "relative min-h-0 shrink overflow-x-hidden overflow-y-auto bg-app-panel transition-[width,opacity] duration-[var(--motion-duration-panel)] ease-[var(--motion-ease-emphasized)] motion-reduce:transition-none",
        interactionClassName
      )}
      data-side={side}
      data-testid={testId}
      inert={inert}
      style={{ maxWidth: taskWorkspacePanelMaxWidth, minWidth: minimumWidth, width: panelWidth }}
    >
      {children}
    </aside>
  );
}

export type TaskWorkspaceShellProps = {
  assigneeChip?: CompactAssigneeChip | null;
  assigneeLabel?: string;
  composer: ReactNode;
  conversation: ReactNode;
  headerAction: ReactNode;
  inspector: ReactNode;
  labels: TaskWorkspaceLabels;
  layout: TaskWorkspaceLayout;
  onReturnToCanvas: () => void;
  timeline: ReactNode;
  workspace: TaskWorkspace;
};

export function TaskWorkspaceStateShell({
  children,
  labels,
  onReturnToCanvas,
  status,
  taskId = null
}: {
  children: ReactNode;
  labels: TaskWorkspaceLabels;
  onReturnToCanvas: () => void;
  status: "idle" | "loading" | "error";
  taskId?: string | null;
}) {
  useTaskWorkspaceReturnShortcut(onReturnToCanvas);

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-app-shell text-text"
      data-task-id={taskId ?? undefined}
      data-testid="task-workspace-shell"
      data-workspace-status={status}
    >
      <header className="app-drag-region window-titlebar-leading flex min-h-11 shrink-0 items-center border-b border-border/80 bg-app-topbar py-1.5 pr-3">
        <Button
          className="app-no-drag"
          data-testid="task-workspace-back"
          size="sm"
          variant="ghost"
          onClick={onReturnToCanvas}
        >
          <ArrowLeftIcon data-icon="inline-start" />
          {labels.backToCanvas}
        </Button>
      </header>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

export function TaskWorkspaceShell({
  assigneeChip = null,
  assigneeLabel,
  composer,
  conversation,
  headerAction,
  inspector,
  labels,
  layout,
  onReturnToCanvas,
  timeline,
  workspace
}: TaskWorkspaceShellProps) {
  useTaskWorkspaceReturnShortcut(onReturnToCanvas);
  const composerSlot = useElementHeight<HTMLDivElement>();
  const retainedInspector = useRef<{ content: ReactNode; workspaceIdentity: string } | null>(null);
  const workspaceIdentity = `${workspace.project.projectId}\0${workspace.project.canvasId}\0${workspace.task.taskId}`;
  const timelineResize = useTimelineResize({
    setTimelineWidth: layout.setTimelineWidth,
    timelineWidth: layout.timelineWidth
  });
  const inspectorResize = useInspectorResize({
    inspectorWidth: layout.inspectorWidth,
    setInspectorWidth: layout.setInspectorWidth
  });

  useEffect(() => {
    if (!layout.inspectorCollapsed) {
      retainedInspector.current = { content: inspector, workspaceIdentity };
    }
  }, [inspector, layout.inspectorCollapsed, workspaceIdentity]);

  let inspectorContent: ReactNode = null;
  if (!layout.inspectorCollapsed) {
    inspectorContent = inspector;
  } else if (retainedInspector.current?.workspaceIdentity === workspaceIdentity) {
    inspectorContent = retainedInspector.current.content;
  }
  const hasOpenedInspector = inspectorContent !== null;

  return (
    <section
      className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-app-shell text-text"
      data-task-id={workspace.task.taskId}
      data-testid="task-workspace-shell"
      data-workspace-status="ready"
    >
      <TaskWorkspaceHeader
        assigneeChip={assigneeChip}
        assigneeLabel={assigneeLabel}
        headerAction={headerAction}
        labels={labels}
        layout={layout}
        onReturnToCanvas={onReturnToCanvas}
        workspace={workspace}
      />
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <AnimatedWorkspacePanel
          collapsed={layout.timelineCollapsed}
          label={labels.timeline}
          side="left"
          testId="task-workspace-timeline-slot"
          width={layout.timelineWidth}
        >
          {timeline}
        </AnimatedWorkspacePanel>
        <main
          className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-app-canvas"
          data-testid="task-workspace-main"
          style={
            {
              minWidth: taskWorkspaceConversationMinWidth,
              "--task-workspace-composer-height": `${composerSlot.height}px`
            } as CSSProperties
          }
        >
          <div
            className="min-h-0 min-w-0 flex-1 overflow-hidden"
            data-testid="task-workspace-conversation-slot"
          >
            {conversation}
          </div>
          {composer ? (
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 z-10"
              data-testid="task-workspace-composer-slot"
              ref={composerSlot.ref}
            >
              {composer}
            </div>
          ) : null}
        </main>
        <AnimatedWorkspacePanel
          collapsed={layout.inspectorCollapsed}
          label={labels.inspector}
          side="right"
          testId={hasOpenedInspector ? "task-workspace-inspector-slot" : undefined}
          width={layout.inspectorWidth}
        >
          {inspectorContent}
        </AnimatedWorkspacePanel>
        {!layout.inspectorCollapsed ? (
          <div
            className="pointer-events-none absolute inset-y-0 right-0 z-30"
            data-testid="task-workspace-inspector-resize-rail"
            style={{ width: layout.inspectorWidth }}
          >
            <VerticalResizeHandle
              aria-label={labels.resizeInspector}
              aria-orientation="vertical"
              aria-valuemax={taskWorkspacePanelMaxWidth}
              aria-valuemin={taskWorkspacePanelMinWidth}
              aria-valuenow={layout.inspectorWidth}
              className="pointer-events-auto"
              onKeyDown={inspectorResize.resizeWithKeyboard}
              onPointerDown={inspectorResize.startResize}
              role="separator"
              side="left"
              tabIndex={0}
            />
          </div>
        ) : null}
      </div>
      {!layout.timelineCollapsed ? (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 z-30"
          data-testid="task-workspace-timeline-resize-rail"
          style={{ width: layout.timelineWidth }}
        >
          <VerticalResizeHandle
            aria-label={labels.resizeTimeline}
            aria-orientation="vertical"
            aria-valuemax={taskWorkspacePanelMaxWidth}
            aria-valuemin={taskWorkspacePanelMinWidth}
            aria-valuenow={layout.timelineWidth}
            className="pointer-events-auto"
            onKeyDown={timelineResize.resizeWithKeyboard}
            onPointerDown={timelineResize.startResize}
            role="separator"
            side="right"
            tabIndex={0}
          />
        </div>
      ) : null}
    </section>
  );
}
