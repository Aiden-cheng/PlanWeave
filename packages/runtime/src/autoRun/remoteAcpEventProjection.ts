import type { NormalizedAcpEvent } from "@planweave-ai/agent-host-protocol/browser";
import {
  normalizedOutputBody,
  normalizedRedactedContent,
  normalizedRunnerEventSchema,
  type NormalizedRunnerEvent
} from "./normalizedEventContract.js";
import { projectAcpTimeline, type AcpTimelineItem } from "./acpConversationProjection.js";
import { redactRunnerEventText } from "./runnerEventRedaction.js";

export function remoteAcpEventBody(
  event: NormalizedAcpEvent,
  seenToolCalls: Set<string>
): NormalizedRunnerEvent["body"] {
  switch (event.kind) {
    case "agent_message": {
      // Remote ACP streams as many agent_message events; mark chunks so the canonical
      // conversation projector coalesces them instead of rendering one line per token.
      const content = normalizedRedactedContent(event.text);
      return { kind: "message", role: "assistant", messageId: null, chunk: true, ...content };
    }
    case "plan": {
      const content = normalizedRedactedContent(event.text);
      return { kind: "plan_update", ...content };
    }
    case "diagnostic":
      return normalizedOutputBody(event.severity === "error" ? "stderr" : "stdout", event.message);
    case "tool_call": {
      const callId = event.callId ?? `remote-tool-${event.cursor}`;
      const status = event.status === "running" ? "in_progress" : event.status;
      const title = redactRunnerEventText(event.title).text;
      if (seenToolCalls.has(callId)) {
        return { kind: "tool_update", callId, status, title, content: null };
      }
      seenToolCalls.add(callId);
      return { kind: "tool_call", callId, status, title, content: null };
    }
  }
}

export function projectRemoteAcpTimeline(events: readonly NormalizedAcpEvent[]): AcpTimelineItem[] {
  const seenToolCalls = new Set<string>();
  const timestamp = new Date(0).toISOString();
  return projectAcpTimeline(
    events.map((event) =>
      normalizedRunnerEventSchema.parse({
        version: "planweave.runner-event/v1",
        sequence: event.cursor,
        timestamp,
        identity: {
          projectId: "remote",
          canvasId: "remote",
          taskId: "remote",
          blockId: "remote",
          claimRef: "remote#remote",
          runId: "remote",
          runOwner: "executor",
          runSessionId: null,
          desktopRunId: null,
          executorRunId: "remote"
        },
        runner: {
          version: "planweave.runner/v1",
          runnerKind: "acp",
          agentId: "codex"
        },
        body: remoteAcpEventBody(event, seenToolCalls)
      })
    )
  );
}
