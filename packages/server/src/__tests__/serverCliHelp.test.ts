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

  it("runs the explicit config migration action and prints its structured result", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const migrateConfig = vi.fn(async (configPath: string) => ({
      schemaVersion: "server-config-migration/v1" as const,
      configPath,
      fromVersion: "server-config/v1" as const,
      toVersion: "server-config/v2" as const,
      changed: true
    }));

    await expect(
      runServerCli(["config", "migrate", "--config", "/tmp/server.json"], {
        io: { stdout, stderr },
        migrateConfig
      })
    ).resolves.toBe(0);

    expect(migrateConfig).toHaveBeenCalledExactlyOnceWith("/tmp/server.json");
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
      schemaVersion: "server-config-migration/v1",
      configPath: "/tmp/server.json",
      fromVersion: "server-config/v1",
      toVersion: "server-config/v2",
      changed: true
    });
    expect(stderr).not.toHaveBeenCalled();
  });

  it("rejects an incomplete config migration command as usage", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const migrateConfig = vi.fn();
    await expect(
      runServerCli(["config", "migrate"], {
        io: { stdout, stderr },
        env: { PLANWEAVE_SERVER_CONFIG: "/tmp/implicit-server.json" },
        migrateConfig
      })
    ).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith("server_config_path_required");
    expect(stdout).not.toHaveBeenCalled();
    expect(migrateConfig).not.toHaveBeenCalled();
  });
});
