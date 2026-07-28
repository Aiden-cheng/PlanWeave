import { spawn } from "node:child_process";
import { cp, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initWorkspace } from "@planweave-ai/runtime";
import { assertSmokeProcess } from "./smokeProcessGate.js";
import { startCollaborationSmokeFixture } from "./collaboration-smoke-fixture.js";

const mainEntry = resolve(process.cwd(), "dist", "main", "main.js");
const electronBin = resolve(process.cwd(), "node_modules", ".bin", "electron");
const repoRoot = resolve(process.cwd(), "../..");
const usePackagedApp = process.env.PLANWEAVE_DESKTOP_SMOKE_PACKAGED === "1";
const localCollaborationOnly = process.argv.includes("--local-collaboration");

async function resolvePackagedExecutable(): Promise<string> {
  const releaseDir = resolve(process.cwd(), "release");
  const entries = await readdir(releaseDir, { withFileTypes: true }).catch(() => []);
  const appPath = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("mac"))
    .map((entry) => resolve(releaseDir, entry.name, "PlanWeave.app"))
    .sort()[0];
  return resolve(
    appPath ?? resolve(releaseDir, "mac-arm64", "PlanWeave.app"),
    "Contents",
    "MacOS",
    "PlanWeave"
  );
}

const smokeHome = await mkdtemp(join(tmpdir(), "planweave-desktop-smoke-home-"));
const smokeUserData = await mkdtemp(join(tmpdir(), "planweave-desktop-smoke-user-data-"));
const smokeProjectRoot = await mkdtemp(join(tmpdir(), "planweave-desktop-smoke-project-"));
process.env.PLANWEAVE_HOME = smokeHome;
const init = await initWorkspace({ projectRoot: smokeProjectRoot });

await cp(
  resolve(repoRoot, "examples", "basic-plan-package", "package"),
  init.workspace.packageDir,
  {
    recursive: true,
    force: true
  }
);
await writeFile(init.workspace.projectPromptFile, "Desktop smoke project prompt.\n", "utf8");

const collaborationFixture = localCollaborationOnly
  ? null
  : await startCollaborationSmokeFixture({
      projectRoot: smokeProjectRoot,
      projectId: init.workspace.id
    });

const smokeCommand = usePackagedApp ? await resolvePackagedExecutable() : electronBin;
const smokeArgs = usePackagedApp ? [] : [mainEntry];

try {
  const child = spawn(smokeCommand, smokeArgs, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PLANWEAVE_HOME: smokeHome,
      PLANWEAVE_DESKTOP_SMOKE_PROJECT_ROOT: smokeProjectRoot,
      PLANWEAVE_DESKTOP_SMOKE_EXTERNAL_PROMPT_PATH: join(
        init.workspace.packageDir,
        "nodes",
        "T-001",
        "prompt.md"
      ),
      PLANWEAVE_DESKTOP_SMOKE_USER_DATA_DIR: smokeUserData,
      PLANWEAVE_DESKTOP_SMOKE: "1",
      ...(localCollaborationOnly
        ? {
            PLANWEAVE_DESKTOP_SMOKE_LOCAL_COLLABORATION: "1",
            PLANWEAVE_DESKTOP_SMOKE_AUTHORITY_PROJECT_ID: init.workspace.id
          }
        : {
            PLANWEAVE_DESKTOP_SMOKE_COLLABORATION_SERVER_URL: collaborationFixture.origin,
            PLANWEAVE_DESKTOP_SMOKE_COLLABORATION_PROJECT_ID: collaborationFixture.projectId,
            PLANWEAVE_DESKTOP_SMOKE_COLLABORATION_INVITATION_TOKEN:
              collaborationFixture.invitationToken
          })
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });

  let output = "";

  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    process.stdout.write(text);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    process.stderr.write(text);
  });

  await assertSmokeProcess(child, () => output, {
    timeoutMs: 30_000,
    terminationGraceMs: 2_000
  });
  if (
    localCollaborationOnly &&
    (output.includes(smokeProjectRoot) ||
      output.includes("projectRoot") ||
      output.includes("pw_operator_"))
  ) {
    throw new Error("Local collaboration smoke output leaked a project root or operator token.");
  }
} finally {
  await collaborationFixture?.close();
}
