import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCodexExecAdapter,
  createOpencodeExecAdapter,
  listWslDistributions,
  prepareExecutionHostInvocation,
  runAutoRunStep
} from "../index.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";

describe("executor environment", () => {
  it.runIf(process.platform === "win32")(
    "does not import a sentinel Windows credential named by WSLENV",
    async ({ skip }) => {
      const distributions = await listWslDistributions({ platform: "win32" });
      const distribution = distributions.distributions[0];
      if (!distributions.available || !distribution) {
        skip(distributions.unavailableReason ?? "No WSL distribution is installed.");
      }

      const prepared = await prepareExecutionHostInvocation({
        host: { kind: "wsl", distribution },
        command: "sh",
        args: [
          "-c",
          'if [ "${PLANWEAVE_WSL_SECRET_SENTINEL+x}" = x ]; then exit 91; fi; printf clean'
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
      ).resolves.toBe("clean");
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
