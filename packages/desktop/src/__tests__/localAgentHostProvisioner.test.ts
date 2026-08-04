import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopLocalAgentHostProvisioner } from "../main/operatorControl/localAgentHostProvisioner.js";
import { LocalAgentHostRegistrationStore } from "../main/operatorControl/localAgentHostRegistrationStore.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Desktop local Agent Host provisioner", () => {
  it("reports the capability as unavailable outside Windows", async () => {
    const provisioner = new DesktopLocalAgentHostProvisioner({
      platform: "darwin",
      launcher: { executablePath: "/Applications/PlanWeave.app/PlanWeave" },
      operator: {} as never
    });
    await expect(provisioner.status("profile-a")).resolves.toMatchObject({
      supported: false,
      state: "not_registered"
    });
  });

  it("persists registration and uses the same PlanWeave executable for background mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-local-agent-host-"));
    roots.push(root);
    const registrations = new LocalAgentHostRegistrationStore(join(root, "registrations.json"), {
      now: () => new Date("2030-01-01T00:00:00.000Z")
    });
    const agents = [
      {
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Codex",
        detected: true,
        exposed: true,
        ready: true
      },
      {
        profileId: "claude-acp",
        agentId: "claude",
        displayName: "Claude",
        detected: true,
        exposed: false,
        ready: false
      }
    ];
    const operator = {
      enrollHandoff: vi.fn().mockResolvedValue({
        state: "ready",
        workspaceId: "workspace-1",
        credential: "active",
        background: "running",
        configPath: "C:\\private\\config.json",
        agents: [
          { ...agents[0], exposed: false, ready: false },
          { ...agents[1], exposed: true, ready: true }
        ],
        nextSteps: {}
      }),
      reconcileAgentExposure: vi.fn().mockResolvedValue({ agents, reload: "restarted" }),
      listAgents: vi.fn().mockResolvedValue(agents),
      backgroundStatus: vi
        .fn()
        .mockResolvedValue({ state: "running", platform: "windows-scheduled-task" })
    };
    const provisioner = new DesktopLocalAgentHostProvisioner({
      platform: "win32",
      launcher: {
        executablePath: "C:\\Program Files\\PlanWeave\\PlanWeave.exe",
        fixedArgs: ["--agent-host-service"]
      },
      operator,
      registrations
    });

    await expect(
      provisioner.register("profile-a", "opaque-handoff", ["codex-acp"])
    ).resolves.toMatchObject({
      supported: true,
      state: "ready",
      workspaceId: "workspace-1",
      agents
    });
    expect(operator.enrollHandoff).toHaveBeenCalledWith("opaque-handoff", {
      installBackground: true,
      executablePath: "C:\\Program Files\\PlanWeave\\PlanWeave.exe",
      fixedArgs: ["--agent-host-service"]
    });
    expect(operator.reconcileAgentExposure).toHaveBeenCalledWith("C:\\private\\config.json", [
      "codex-acp"
    ]);
    await expect(provisioner.status("profile-a")).resolves.toMatchObject({
      state: "ready",
      workspaceId: "workspace-1",
      agents
    });
  });
});
