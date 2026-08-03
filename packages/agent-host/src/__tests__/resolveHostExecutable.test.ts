import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveHostExecutable } from "../platform/resolveHostExecutable.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("resolveHostExecutable", () => {
  it("resolves an executable POSIX command to its canonical absolute path", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-host-executable-posix-"));
    roots.push(root);
    const commandPath = join(root, "codex-acp");
    await writeFile(commandPath, "#!/bin/sh\n", "utf8");
    await chmod(commandPath, 0o755);

    const resolved = await resolveHostExecutable({
      command: "codex-acp",
      env: { PATH: root },
      platform: "darwin"
    });

    expect(resolved?.endsWith("/codex-acp")).toBe(true);
  });

  it("uses Windows Path and PATHEXT to discover npm command shims", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-host-executable-win32-"));
    roots.push(root);
    const commandPath = join(root, "installed-codex-acp.cmd");
    await writeFile(commandPath, "@echo off\r\n", "utf8");
    await symlink(commandPath, join(root, "codex-acp.cmd"));

    await expect(
      resolveHostExecutable({
        command: "codex-acp",
        env: {
          Path: root,
          PATHEXT: ".CMD",
          NoDefaultCurrentDirectoryInExePath: "1"
        },
        platform: "win32"
      })
    ).resolves.toBe(await realpath(commandPath));
  });

  it("does not treat PowerShell scripts as Windows executables", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-host-executable-ps1-"));
    roots.push(root);
    await writeFile(join(root, "codex-acp.ps1"), "exit 0\r\n", "utf8");

    await expect(
      resolveHostExecutable({
        command: "codex-acp",
        env: {
          Path: root,
          PATHEXT: ".PS1",
          NoDefaultCurrentDirectoryInExePath: "1"
        },
        platform: "win32"
      })
    ).resolves.toBeNull();
  });
});
