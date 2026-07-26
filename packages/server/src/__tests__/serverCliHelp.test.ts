import { describe, expect, it, vi } from "vitest";
import { runServerCli, SERVER_CLI_USAGE } from "../bin.js";

describe("planweave-server CLI help", () => {
  it.each(["--help", "-h"])("prints public usage and exits 0 for %s", async (argument) => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    await expect(runServerCli([argument], { io: { stdout, stderr } })).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith(SERVER_CLI_USAGE);
    expect(stderr).not.toHaveBeenCalled();
  });

  it("reports usage on stderr and exits 2 when no command is provided", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    await expect(runServerCli([], { io: { stdout, stderr } })).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledExactlyOnceWith("server_cli_usage");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("still rejects unknown commands with usage exit code", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    await expect(runServerCli(["unknown"], { io: { stdout, stderr } })).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith("server_cli_usage");
    expect(stdout).not.toHaveBeenCalled();
  });
});
