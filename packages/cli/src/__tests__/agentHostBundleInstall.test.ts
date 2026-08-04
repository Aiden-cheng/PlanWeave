import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { renderAgentHostInstallScript } from "../../../../scripts/build-agent-host-bundle.mjs";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("Agent Host VPS bundle installer", () => {
  it("installs one planweave command and forwards Agent Host arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-agent-host-installer-"));
    directories.push(root);
    const bundle = join(root, "bundle");
    const installRoot = join(root, "installed");
    const binDir = join(root, "bin");
    await mkdir(join(bundle, "app/dist"), { recursive: true });
    const entrypoint = join(bundle, "app/dist/index.js");
    await writeFile(
      entrypoint,
      "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n",
      "utf8"
    );
    await chmod(entrypoint, 0o755);
    const installer = join(bundle, "install.sh");
    await writeFile(installer, renderAgentHostInstallScript("0.3.0-test"), "utf8");
    await chmod(installer, 0o755);

    const env = {
      ...process.env,
      PLANWEAVE_INSTALL_ROOT: installRoot,
      PLANWEAVE_BIN_DIR: binDir
    };
    await execFileAsync("sh", [installer], { env });
    const { stdout } = await execFileAsync(
      join(binDir, "planweave"),
      ["agent-host", "enroll", "opaque", "--expose", "codex-acp"],
      { env }
    );

    expect(JSON.parse(stdout)).toEqual([
      "agent-host",
      "enroll",
      "opaque",
      "--expose",
      "codex-acp"
    ]);
    expect(await readFile(join(installRoot, "current/dist/index.js"), "utf8")).toContain(
      "process.argv.slice(2)"
    );
  });
});
