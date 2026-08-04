import { describe, expect, it, vi } from "vitest";
import {
  parseDesktopAgentHostServiceArgs,
  runDesktopAgentHostServiceMode
} from "../main/desktopAgentHostServiceMode.js";

describe("Desktop Agent Host service mode", () => {
  it("leaves ordinary Desktop launches untouched", async () => {
    const run = vi.fn();
    expect(parseDesktopAgentHostServiceArgs(["PlanWeave.exe"])).toBeNull();
    await expect(runDesktopAgentHostServiceMode(["PlanWeave.exe"], run)).resolves.toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("forwards the scheduled-task run command without starting Desktop UI", async () => {
    const run = vi.fn().mockResolvedValue(0);
    const argv = [
      "PlanWeave.exe",
      "--agent-host-service",
      "run",
      "--config",
      "C:\\Users\\tester\\.planweave\\agent-host\\config.json"
    ];
    await expect(runDesktopAgentHostServiceMode(argv, run)).resolves.toBe(0);
    expect(run).toHaveBeenCalledWith([
      "run",
      "--config",
      "C:\\Users\\tester\\.planweave\\agent-host\\config.json"
    ]);
  });
});
