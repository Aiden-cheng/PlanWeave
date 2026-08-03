import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentHostSetupHandoffSchema,
  serializeAgentHostSetupHandoff
} from "@planweave-ai/agent-host-protocol";
import {
  configFromAgentHostSetupHandoff,
  resolveAgentHostDefaultPaths
} from "../config/defaultPaths.js";
import { parseAgentHostArgs, runAgentHostCli } from "../operator/cli.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

function encodedHandoff() {
  return serializeAgentHostSetupHandoff(
    agentHostSetupHandoffSchema.parse({
      version: "agent-host-setup/v1",
      endpoint: {
        topology: "lan_http",
        serverOrigin: "http://192.168.1.8:4317",
        allowedClientOrigins: ["http://192.168.1.8:4317"],
        tlsTrust: "not_applicable"
      },
      workspaceId: "workspace-1",
      enrollmentCode: `pw_enroll_${"a".repeat(43)}`,
      expiresAt: "2030-01-01T00:00:00.000Z",
      display: { workspaceName: "Studio", serverName: "Private server" }
    })
  );
}

describe("portable Agent Host setup", () => {
  it("derives private per-workspace paths and a config without the one-time code", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-portable-host-"));
    directories.push(home);
    const handoff = encodedHandoff();
    const paths = resolveAgentHostDefaultPaths("workspace-1", home);
    const config = configFromAgentHostSetupHandoff(
      (await import("@planweave-ai/agent-host-protocol")).parseAgentHostSetupHandoff(
        handoff,
        new Date("2029-01-01")
      ),
      { paths, hostDisplayName: "Build host" }
    );
    expect(config.coordinator.endpoint?.topology).toBe("lan_http");
    expect(config.agentProfiles).toEqual([]);
    expect(paths.configPath).toContain(join("instances", "workspace-1"));
    expect(JSON.stringify(config)).not.toContain("pw_enroll_");
  });

  it("parses the single-command handoff and exposure commands", () => {
    expect(parseAgentHostArgs(["enroll", encodedHandoff(), "--no-background"])).toMatchObject({
      command: "enroll",
      handoff: encodedHandoff(),
      installBackground: false
    });
    expect(parseAgentHostArgs(["agents", "expose", "codex-acp", "--config", "/cfg"])).toEqual({
      command: "agents-expose",
      configPath: "/cfg",
      profileId: "codex-acp",
      replace: false
    });
  });

  it("does not echo a handoff when enrollment fails", async () => {
    const stderr = vi.fn();
    const handoff = encodedHandoff();
    await expect(
      runAgentHostCli(["enroll", handoff], {
        operator: {
          enrollHandoff: vi.fn().mockRejectedValue(new Error("private handoff payload"))
        } as never,
        io: { stdout: vi.fn(), stderr }
      })
    ).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith("agent_host_failed");
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(handoff);
  });
});
