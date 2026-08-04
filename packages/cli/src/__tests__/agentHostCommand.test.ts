import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { createProgram } from "../index.js";
import { registerAgentHostCommand } from "../commands/agentHost.js";

describe("planweave agent-host", () => {
  it("is registered on the public PlanWeave CLI", () => {
    expect(createProgram().commands.map((command) => command.name())).toContain("agent-host");
  });

  it("delegates arguments and installs the unified command as the background launcher", async () => {
    const run = vi.fn().mockResolvedValue(0);
    const program = new Command().name("planweave");
    registerAgentHostCommand(program, {
      argv: ["/usr/bin/node", "/opt/planweave/dist/index.js"],
      executablePath: "/usr/bin/node",
      run
    });

    await program.parseAsync([
      "/usr/bin/node",
      "/opt/planweave/dist/index.js",
      "agent-host",
      "enroll",
      "planweave-agent-host-setup:opaque",
      "--no-background"
    ]);

    expect(run).toHaveBeenCalledWith(
      ["enroll", "planweave-agent-host-setup:opaque", "--no-background"],
      expect.objectContaining({
        launcher: {
          executablePath: "/usr/bin/node",
          fixedArgs: ["/opt/planweave/dist/index.js", "agent-host"]
        }
      })
    );
  });

  it("passes help through and preserves the Agent Host exit code", async () => {
    const run = vi.fn().mockResolvedValue(2);
    const setExitCode = vi.fn();
    const program = new Command().name("planweave");
    registerAgentHostCommand(program, {
      argv: ["node", "/opt/planweave/dist/index.js"],
      executablePath: "node",
      run,
      setExitCode
    });

    await program.parseAsync(["node", "planweave", "agent-host", "--help"]);

    expect(run).toHaveBeenCalledWith(
      ["--help"],
      expect.objectContaining({
        launcher: {
          executablePath: "node",
          fixedArgs: ["/opt/planweave/dist/index.js", "agent-host"]
        }
      })
    );
    expect(setExitCode).toHaveBeenCalledWith(2);
  });
});
