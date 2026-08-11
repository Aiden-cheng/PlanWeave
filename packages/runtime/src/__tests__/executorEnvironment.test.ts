import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ExecutorCancelledError,
  executorHeartbeatPath,
  execWithStreaming
} from "../autoRun/executorShared.js";
import {
  createCodexExecAdapter,
  createOpencodeExecAdapter,
  listWslDistributions,
  prepareExecutionHostInvocation,
  runAutoRunStep
} from "../index.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";

const WSL_DISTRIBUTION = "Ubuntu";
const WSL_LAUNCH_TIMEOUT_MS = 30_000;
const WSL_LIFECYCLE_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readWslLifecyclePids(output: string): { parentPid: number; childPid: number } | undefined {
  const parentMatch = /^PLANWEAVE_PARENT_PID=(\d+)$/m.exec(output);
  const childMatch = /^PLANWEAVE_CHILD_PID=(\d+)$/m.exec(output);
  if (!parentMatch || !childMatch) {
    return undefined;
  }
  const parentPid = Number.parseInt(parentMatch[1], 10);
  const childPid = Number.parseInt(childMatch[1], 10);
  if (parentPid <= 1 || childPid <= 1) {
    return undefined;
  }
  return { parentPid, childPid };
}

async function waitForWslLifecyclePids(
  statePath: string
): Promise<{ parentPid: number; childPid: number }> {
  const deadline = Date.now() + WSL_LIFECYCLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const pids = readWslLifecyclePids(await readFile(statePath, "utf8"));
      if (pids) {
        return pids;
      }
    } catch {
      // The WSL process has not written this readiness marker yet.
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for WSL lifecycle process markers: ${statePath}`);
}

async function waitForWslLifecyclePidsWhileRunning(
  statePath: string,
  running: Promise<unknown>
): Promise<{ parentPid: number; childPid: number }> {
  return Promise.race([
    waitForWslLifecyclePids(statePath),
    running.then(
      () => {
        throw new Error("WSL process exited before reporting its lifecycle process markers.");
      },
      (error: unknown) => {
        throw error;
      }
    )
  ]);
}

async function waitForFile(
  path: string,
  label: string,
  timeoutMs = WSL_LIFECYCLE_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch {
      // The WSL process has not written this readiness marker yet.
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for WSL ${label} marker: ${path}`);
}

async function waitForFileWhileRunning(
  path: string,
  label: string,
  running: Promise<unknown>,
  timeoutMs: number
): Promise<void> {
  return Promise.race([
    waitForFile(path, label, timeoutMs),
    running.then(
      () => {
        throw new Error(`WSL process exited before writing the ${label} marker.`);
      },
      (error: unknown) => {
        throw error;
      }
    )
  ]);
}

function wslExitCode(
  distribution: string,
  script: string,
  args: readonly string[] = []
): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      "wsl.exe",
      ["--distribution", distribution, "--exec", "sh", "-c", script, "planweave-wsl-test", ...args],
      { windowsHide: true, timeout: WSL_LIFECYCLE_TIMEOUT_MS },
      (error) => {
        if (!error) {
          resolve(0);
          return;
        }
        if (typeof error.code === "number") {
          resolve(error.code);
          return;
        }
        reject(error);
      }
    );
  });
}

async function waitForWslProcessesToExit(options: {
  distribution: string;
  parentPid: number;
  childPid: number;
}): Promise<void> {
  const deadline = Date.now() + WSL_LIFECYCLE_TIMEOUT_MS;
  const probe = [
    'for pw_pid in "$@"; do',
    '  if kill -0 "$pw_pid" 2>/dev/null; then exit 1; fi',
    "done",
    'kill -0 -- "-$1" 2>/dev/null && exit 2',
    "exit 0"
  ].join("; ");
  while (Date.now() < deadline) {
    if (
      (await wslExitCode(options.distribution, probe, [
        String(options.parentPid),
        String(options.childPid)
      ])) === 0
    ) {
      return;
    }
    await sleep(25);
  }
  throw new Error(
    `WSL parent pid ${String(options.parentPid)}, child pid ${String(options.childPid)}, or their process group remained alive after cancellation.`
  );
}

async function assertWslProcessGroup(options: {
  distribution: string;
  parentPid: number;
  childPid: number;
}): Promise<void> {
  const probe = [
    'pw_parent_group="$(ps -o pgid= -p "$1" | tr -d " ")"',
    'pw_child_group="$(ps -o pgid= -p "$2" | tr -d " ")"',
    '[ "$pw_parent_group" = "$1" ] && [ "$pw_child_group" = "$1" ]'
  ].join("; ");
  const exitCode = await wslExitCode(options.distribution, probe, [
    String(options.parentPid),
    String(options.childPid)
  ]);
  expect(exitCode).toBe(0);
}

async function forceStopWslProcessGroup(distribution: string, parentPid: number): Promise<void> {
  const script = [
    'pw_pid="$1"',
    'case "$pw_pid" in ""|*[!0-9]*) exit 0;; esac',
    '[ "$pw_pid" -gt 1 ] || exit 0',
    'kill -KILL -- "-$pw_pid" 2>/dev/null || true'
  ].join("; ");
  await wslExitCode(distribution, script, [String(parentPid)]);
}

const WSL_LIFECYCLE_PROCESS_SCRIPT = [
  'pw_state_path="$1"',
  'pw_child_pid_path="$2"',
  'child_program=\'trap "" TERM; printf "%s\\n" "$$" > "$1"; while :; do sleep 1; done\'',
  'sh -c "$child_program" planweave-wsl-child "$pw_child_pid_path" &',
  'while [ ! -s "$pw_child_pid_path" ]; do sleep 0.05; done',
  'pw_child_pid="$(cat "$pw_child_pid_path")"',
  'printf "PLANWEAVE_PARENT_PID=%s\\nPLANWEAVE_CHILD_PID=%s\\n" "$$" "$pw_child_pid" > "$pw_state_path"',
  "trap 'exit 0' TERM",
  "wait"
].join("\n");

describe("executor environment", () => {
  const requireWslTests = process.env.PLANWEAVE_REQUIRE_WSL_TESTS === "1";

  it.runIf(process.platform === "win32")(
    "does not import a sentinel Windows credential named by WSLENV",
    async ({ skip }) => {
      const distributions = await listWslDistributions({ platform: "win32" });
      const distribution = "Ubuntu";
      if (!distributions.available || !distributions.distributions.includes(distribution)) {
        const reason = distributions.unavailableReason
          ? `Ubuntu WSL distribution is required: ${distributions.unavailableReason}`
          : "Ubuntu WSL distribution is required.";
        if (requireWslTests) {
          throw new Error(reason);
        }
        skip(reason);
      }

      const prepared = await prepareExecutionHostInvocation({
        host: { kind: "wsl", distribution },
        command: "sh",
        args: [
          "-c",
          'if [ "${PLANWEAVE_WSL_SECRET_SENTINEL+x}" = x ]; then exit 91; fi; if [ "$WSL_DISTRO_NAME" != "Ubuntu" ]; then exit 92; fi; printf "%s:clean" "$WSL_DISTRO_NAME"'
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          WSLENV: "PLANWEAVE_WSL_SECRET_SENTINEL/u",
          PLANWEAVE_WSL_SECRET_SENTINEL: "must-not-cross-host"
        },
        platform: "win32"
      });

      await expect(
        new Promise<string>((resolve, reject) => {
          execFile(
            prepared.command,
            prepared.args,
            {
              encoding: "utf8",
              env: prepared.spawnEnvironment,
              timeout: 30_000,
              windowsHide: true
            },
            (error, stdout) => {
              if (error) {
                reject(error);
                return;
              }
              resolve(String(stdout));
            }
          );
        })
      ).resolves.toBe("Ubuntu:clean");
    },
    60_000
  );

  it.runIf(process.platform === "win32")(
    "cancels a WSL process group and finalizes executor lifecycle",
    async ({ skip }) => {
      const distributions = await listWslDistributions({ platform: "win32" });
      if (!distributions.available || !distributions.distributions.includes(WSL_DISTRIBUTION)) {
        const reason = distributions.unavailableReason
          ? `${WSL_DISTRIBUTION} WSL distribution is required: ${distributions.unavailableReason}`
          : `${WSL_DISTRIBUTION} WSL distribution is required.`;
        if (requireWslTests) {
          throw new Error(reason);
        }
        skip(reason);
      }

      const runDir = await mkdtemp(join(homedir(), ".planweave-wsl-lifecycle-"));
      const statePath = join(runDir, "lifecycle.state");
      const childPidPath = join(runDir, "child.pid");
      const stdoutPath = join(runDir, "stdout.log");
      const abort = new AbortController();
      let parentPid: number | undefined;
      let childPid: number | undefined;
      let running: ReturnType<typeof execWithStreaming> | undefined;
      let processGroupExited = false;

      try {
        running = execWithStreaming({
          command: "sh",
          args: [
            "-c",
            WSL_LIFECYCLE_PROCESS_SCRIPT,
            "planweave-wsl-lifecycle",
            statePath,
            childPidPath
          ],
          pathArgIndexes: [3, 4],
          cwd: runDir,
          stdin: "",
          host: { kind: "wsl", distribution: WSL_DISTRIBUTION },
          stdoutPath,
          stderrPath: join(runDir, "stderr.log"),
          timeoutMs: 60_000,
          maxStdoutBytes: 1024,
          maxStderrBytes: 1024,
          signal: abort.signal
        });

        await waitForFileWhileRunning(
          executorHeartbeatPath(stdoutPath),
          "executor launch",
          running,
          WSL_LAUNCH_TIMEOUT_MS
        );
        ({ parentPid, childPid } = await waitForWslLifecyclePidsWhileRunning(statePath, running));
        await assertWslProcessGroup({
          distribution: WSL_DISTRIBUTION,
          parentPid,
          childPid
        });

        abort.abort(new Error("test cancellation"));
        await expect(running).rejects.toBeInstanceOf(ExecutorCancelledError);
        await waitForWslProcessesToExit({
          distribution: WSL_DISTRIBUTION,
          parentPid,
          childPid
        });
        processGroupExited = true;
        await expect(
          readFile(executorHeartbeatPath(stdoutPath), "utf8").then(
            (content) => JSON.parse(content) as Record<string, unknown>
          )
        ).resolves.toMatchObject({
          status: "failed",
          timedOut: false,
          finishedAt: expect.any(String),
          error: "Executor cancelled."
        });
      } finally {
        abort.abort();
        try {
          await running?.catch((error: unknown) => {
            if (!(error instanceof ExecutorCancelledError)) {
              throw error;
            }
          });
        } finally {
          try {
            if (parentPid !== undefined && !processGroupExited) {
              await forceStopWslProcessGroup(WSL_DISTRIBUTION, parentPid);
              if (childPid !== undefined) {
                await waitForWslProcessesToExit({
                  distribution: WSL_DISTRIBUTION,
                  parentPid,
                  childPid
                });
                processGroupExited = true;
              }
            }
          } finally {
            await rm(runDir, { recursive: true, force: true });
          }
        }
      }
    },
    60_000
  );

  it("runs codex-exec in the project directory with the PlanWeave data home", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            "let input='';",
            "process.stdin.on('data', c => input += c);",
            "process.stdin.on('end', () => {",
            "  fs.writeFileSync(path.join(process.cwd(), 'codex-cwd.txt'), process.cwd());",
            "  fs.writeFileSync(path.join(process.cwd(), 'codex-planweave-home.txt'), process.env.PLANWEAVE_HOME ?? '');",
            "  console.log('report:' + input.includes('Implement task'));",
            "});"
          ].join("")
        ]
      })
      .withDefaultExecutor("fake-codex")
      .build();
    const { root, init } = await createTestWorkspace(manifest);
    const previousHome = process.env.PLANWEAVE_HOME;
    process.env.PLANWEAVE_HOME = join(root, "polluted-planweave-home");

    try {
      await expect(
        runAutoRunStep({
          projectRoot: init.workspace,
          executor: createCodexExecAdapter({
            projectRoot: init.workspace,
            executorName: "fake-codex"
          })
        })
      ).resolves.toMatchObject({
        kind: "submitted",
        claim: { kind: "block", ref: "T-001#B-001" },
        submitResult: { ref: "T-001#B-001", runId: "RUN-001", status: "completed" }
      });
    } finally {
      process.env.PLANWEAVE_HOME = previousHome;
    }

    await expect(readFile(join(root, "codex-cwd.txt"), "utf8")).resolves.toBe(
      init.workspace.rootPath
    );
    await expect(readFile(join(root, "codex-planweave-home.txt"), "utf8")).resolves.toBe(
      init.workspace.planweaveHome
    );
  });

  it("runs opencode-exec in the project directory with the PlanWeave data home", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-opencode", {
        adapter: "opencode-exec",
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            "let input='';",
            "process.stdin.on('data', c => input += c);",
            "process.stdin.on('end', () => {",
            "  fs.writeFileSync(path.join(process.cwd(), 'opencode-cwd.txt'), process.cwd());",
            "  fs.writeFileSync(path.join(process.cwd(), 'opencode-planweave-home.txt'), process.env.PLANWEAVE_HOME ?? '');",
            "  console.error('  Continue  opencode -s ses_env_123');",
            "  console.log('opencode report:' + input.includes('Implement task'));",
            "});"
          ].join("")
        ]
      })
      .withDefaultExecutor("fake-opencode")
      .build();
    const { root, init } = await createTestWorkspace(manifest);
    const previousHome = process.env.PLANWEAVE_HOME;
    process.env.PLANWEAVE_HOME = join(root, "polluted-planweave-home");

    try {
      await expect(
        runAutoRunStep({
          projectRoot: init.workspace,
          executor: createOpencodeExecAdapter({
            projectRoot: init.workspace,
            executorName: "fake-opencode"
          })
        })
      ).resolves.toMatchObject({
        kind: "submitted",
        claim: { kind: "block", ref: "T-001#B-001" },
        submitResult: { ref: "T-001#B-001", runId: "RUN-001", status: "completed" }
      });
    } finally {
      process.env.PLANWEAVE_HOME = previousHome;
    }

    await expect(readFile(join(root, "opencode-cwd.txt"), "utf8")).resolves.toBe(
      init.workspace.rootPath
    );
    await expect(readFile(join(root, "opencode-planweave-home.txt"), "utf8")).resolves.toBe(
      init.workspace.planweaveHome
    );
  });
});
