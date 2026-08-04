import { afterEach, describe, expect, it } from "vitest";
import { getAutoRunState, startAutoRun, stopAutoRun } from "../desktop/index.js";
import { getRunSession } from "../runSessions/index.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

const startedRunIds = new Set<string>();

afterEach(async () => {
  await Promise.all([...startedRunIds].map((runId) => stopAutoRun(runId).catch(() => undefined)));
  startedRunIds.clear();
});

async function waitForRun(
  runId: string,
  predicate: (state: Awaited<ReturnType<typeof getAutoRunState>>) => boolean
) {
  let state = await getAutoRunState(runId);
  for (let attempt = 0; attempt < 500 && !predicate(state); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    state = await getAutoRunState(runId);
  }
  return state;
}

function runSessionIdFor(state: Awaited<ReturnType<typeof getAutoRunState>>): string {
  expect(state.runSessionId).toEqual(expect.any(String));
  if (!state.runSessionId) {
    throw new Error(`Auto Run '${state.runId}' is missing runSessionId.`);
  }
  return state.runSessionId;
}

describe("desktop Auto Run executor override", () => {
  it("records a one-run override without changing the manifest default", async () => {
    const command = (label: string) => ({
      adapter: "codex-exec" as const,
      command: process.execPath,
      args: [
        "-e",
        `let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.log('${label} ' + input.split('\\n')[0]); });`
      ]
    });
    const manifest = manifestTestBuilder()
      .withExecutor("default-codex", command("default executor"))
      .withExecutor("selected-codex", command("selected executor"))
      .withDefaultExecutor("default-codex")
      .build();
    const { root } = await createTestWorkspace(manifest);

    const started = await startAutoRun(root, null, { kind: "block", blockRef: "T-001#B-001" }, 1, {
      tmuxEnabled: false,
      executorOverride: "selected-codex"
    });
    startedRunIds.add(started.runId);
    const paused = await waitForRun(started.runId, (state) => state.phase === "paused");

    expect(paused.options.executorOverride).toBe("selected-codex");
    expect(paused.currentExecutor).toBe("selected-codex");
    expect(paused.latestOutputSummary).toContain("selected executor");
    await expect(getRunSession(root, runSessionIdFor(paused))).resolves.toMatchObject({
      session: {
        autoRun: {
          executorOverride: "selected-codex",
          effectiveExecutor: "selected-codex"
        }
      }
    });
    expect(manifest.execution.defaultExecutor).toBe("default-codex");
  });
});
