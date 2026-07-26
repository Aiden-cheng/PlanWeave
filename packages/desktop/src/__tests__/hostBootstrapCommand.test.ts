import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  buildAgentHostBootstrapCommand,
  quotePosixShellArgument
} from "../renderer/settings/hostBootstrapCommand";

const execFileAsync = promisify(execFile);

describe("Agent Host bootstrap shell command", () => {
  it("uses POSIX single-quote escaping for every argument", () => {
    expect(quotePosixShellArgument("/tmp/a b'c")).toBe("'/tmp/a b'\"'\"'c'");
    expect(
      buildAgentHostBootstrapCommand({
        configPath: "/tmp/agent host.json",
        enrollmentCode: `pw_enroll_${"A".repeat(43)}`
      })
    ).toContain("--config '/tmp/agent host.json'");
  });

  it.skipIf(process.platform === "win32")(
    "preserves substitution syntax as literal argv through a real POSIX shell",
    async () => {
      const configPath = "/tmp/$(printf INJECTED)/`printf TICKED`/agent host's.json";
      const enrollmentCode = `pw_enroll_${"A".repeat(43)}`;
      const command = buildAgentHostBootstrapCommand({ configPath, enrollmentCode }).replaceAll(
        "planweave-agent-host",
        "capture"
      );
      const shell = [
        "capture() {",
        "  for argument do printf '<%s>\\n' \"$argument\"; done",
        "}",
        command
      ].join("\n");

      const { stdout } = await execFileAsync("/bin/sh", ["-c", shell]);

      expect(stdout).toContain(`<${configPath}>`);
      expect(stdout).toContain(`<${enrollmentCode}>`);
      expect(stdout).toContain("$(printf INJECTED)");
      expect(stdout).toContain("`printf TICKED`");
      expect(stdout).not.toContain("</tmp/INJECTED/TICKED/");
    }
  );
});
