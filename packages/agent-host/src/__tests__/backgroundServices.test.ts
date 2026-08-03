import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinuxUserSystemdService, linuxAgentHostUnitText } from "../background/linuxUserSystemd.js";
import { WindowsScheduledTaskService } from "../background/windowsScheduledTask.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

const install = {
  workspaceId: "workspace-1",
  executablePath: "/opt/PlanWeave/planweave-agent-host",
  configPath: "/home/user/.planweave/agent-host/instances/workspace-1/config.json",
  privateDirectory: "/home/user/.planweave/agent-host"
};

describe("Agent Host background adapters", () => {
  it("writes a user systemd unit containing only executable and config arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-systemd-"));
    directories.push(root);
    const runner = vi.fn().mockResolvedValue({ stdout: "active\n", stderr: "" });
    await new LinuxUserSystemdService(runner, root).install(install);
    const unit = await readFile(join(root, "planweave-agent-host-workspace-1.service"), "utf8");
    expect(unit).toContain(
      'run --config "/home/user/.planweave/agent-host/instances/workspace-1/config.json"'
    );
    expect(unit).not.toMatch(/pw_(?:enroll|host)_/);
    expect(runner).toHaveBeenNthCalledWith(1, "systemctl", ["--user", "daemon-reload"]);
    expect(runner).toHaveBeenNthCalledWith(2, "systemctl", [
      "--user",
      "enable",
      "--now",
      "planweave-agent-host-workspace-1.service"
    ]);
  });

  it.each([
    ["executable newline", { executablePath: "/opt/PlanWeave/host\nEnvironment=BAD=1" }],
    ["config carriage return", { configPath: "/tmp/config.json\rExecStart=/bin/false" }],
    ["executable NUL", { executablePath: "/opt/PlanWeave/host\0suffix" }]
  ])("rejects %s at the systemd unit construction boundary", (_label, override) => {
    expect(() => linuxAgentHostUnitText({ ...install, ...override })).toThrow(
      "agent_host_background_unit_value_invalid"
    );
  });

  it("creates a LIMITED current-user ONLOGON task with fixed argv", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    await new WindowsScheduledTaskService(runner).install({
      ...install,
      executablePath: "C:\\PlanWeave\\planweave-agent-host.exe",
      configPath: "C:\\Users\\user\\.planweave\\agent-host\\config.json",
      privateDirectory: "C:\\Users\\user\\.planweave\\agent-host"
    });
    const createArgs = runner.mock.calls[0]?.[1] as string[];
    expect(createArgs).toContain("ONLOGON");
    expect(createArgs).toContain("LIMITED");
    expect(createArgs.join(" ")).not.toMatch(/pw_(?:enroll|host)_/);
  });
});
