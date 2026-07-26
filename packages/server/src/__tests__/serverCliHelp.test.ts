import { describe, expect, it, vi } from "vitest";
import { runServerCli, SERVER_CLI_USAGE } from "../bin.js";

describe("planweave-server CLI help", () => {
  it.each([
    { argv: [] as string[] },
    { argv: ["--help"] },
    { argv: ["-h"] }
  ])("prints public usage and exits 0 for $argv", async ({ argv }) => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    await expect(runServerCli(argv, { io: { stdout, stderr } })).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith(SERVER_CLI_USAGE);
    expect(stderr).not.toHaveBeenCalled();
  });

  it("still rejects unknown commands with usage exit code", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    await expect(runServerCli(["unknown"], { io: { stdout, stderr } })).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith("server_cli_usage");
    expect(stdout).not.toHaveBeenCalled();
  });
});
