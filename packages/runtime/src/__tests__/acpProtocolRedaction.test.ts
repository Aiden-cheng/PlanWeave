import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeAcpSessionNotification } from "../autoRun/acpEventNormalization.js";
import { AcpEventStore } from "../autoRun/acpEventStore.js";
import { runnerIdentitySchema, runnerRunIdentitySchema } from "../autoRun/runnerContractSchemas.js";

describe("ACP protocol persistence redaction", () => {
  it("persists ordinary Basic text without treating it as a credential", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-basic-prose-"));
    const store = new AcpEventStore({
      runDir,
      identity: runnerRunIdentitySchema.parse({
        projectId: "project-1",
        canvasId: "default",
        taskId: "T-002",
        blockId: "B-002",
        claimRef: "T-002#B-002",
        runId: "RUN-001",
        runOwner: "executor",
        runSessionId: null,
        desktopRunId: null,
        executorRunId: "RUN-001"
      }),
      runner: runnerIdentitySchema.parse({
        version: "planweave.runner/v1",
        runnerKind: "acp",
        agentId: "codex"
      })
    });
    expect(await store.open()).toEqual([]);
    const notification = {
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update" as const,
        toolCallId: "tool-1",
        status: "completed" as const,
        rawOutput: {
          formatted_output: '{"project":{"title":"Basic PlanWeave Example"}}',
          exit_code: 0
        }
      }
    };
    await store.appendProtocol("agent_to_client", {
      jsonrpc: "2.0",
      method: "session/update",
      params: notification
    });
    const normalized = normalizeAcpSessionNotification(notification);
    expect(normalized).not.toBeNull();
    if (normalized) await store.append(normalized, { sessionId: "session-1" });
    await store.drain();

    const protocol = await readFile(join(runDir, "protocol.ndjson"), "utf8");
    const events = await readFile(join(runDir, "events.ndjson"), "utf8");
    expect(protocol).toContain("Basic PlanWeave Example");
    expect(events).toContain("Basic PlanWeave Example");
    expect(protocol).not.toContain("[REDACTED:CREDENTIAL]");
    expect(events).not.toContain("[REDACTED:CREDENTIAL]");
  });

  it("fails closed for malformed terminal authentication methods", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-auth-redaction-"));
    const store = new AcpEventStore({
      runDir,
      identity: runnerRunIdentitySchema.parse({
        projectId: "project-1",
        canvasId: "default",
        taskId: "T-003",
        blockId: "B-001",
        claimRef: "T-003#B-001",
        runId: "RUN-001",
        runOwner: "executor",
        runSessionId: null,
        desktopRunId: null,
        executorRunId: "RUN-001"
      }),
      runner: runnerIdentitySchema.parse({
        version: "planweave.runner/v1",
        runnerKind: "acp",
        agentId: "codex"
      })
    });
    expect(await store.open()).toEqual([]);
    await store.appendProtocol("agent_to_client", {
      jsonrpc: "2.0",
      id: 1,
      result: {
        authMethods: [
          {
            id: "valid-terminal",
            name: "Valid terminal",
            type: "terminal",
            env: { CUSTOM_AUTH_ALPHA: "opaque-alpha" }
          },
          {
            id: "missing-name",
            type: "terminal",
            env: { CUSTOM_AUTH_BETA: "opaque-beta" }
          },
          {
            id: "null-name",
            name: null,
            type: "terminal",
            env: { CUSTOM_AUTH_GAMMA: "opaque-gamma" }
          },
          {
            name: "Missing id",
            type: "terminal",
            env: { CUSTOM_AUTH_DELTA: "opaque-delta" },
            _meta: { private: "opaque-metadata" }
          }
        ],
        ordinary: { env: { CUSTOM_RUNTIME_VALUE: "ordinary-opaque" } }
      }
    });

    const protocol = await readFile(join(runDir, "protocol.ndjson"), "utf8");
    for (const forbidden of [
      "CUSTOM_AUTH_ALPHA",
      "opaque-alpha",
      "CUSTOM_AUTH_BETA",
      "opaque-beta",
      "CUSTOM_AUTH_GAMMA",
      "opaque-gamma",
      "CUSTOM_AUTH_DELTA",
      "opaque-delta",
      "_meta",
      "opaque-metadata"
    ]) {
      expect(protocol).not.toContain(forbidden);
    }
    expect(protocol).toContain("CUSTOM_RUNTIME_VALUE");
    expect(protocol).toContain("ordinary-opaque");
  });
});
