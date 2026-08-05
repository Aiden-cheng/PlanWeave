import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentHostDefaultPaths } from "@planweave-ai/agent-host";
import { DesktopLocalAgentHostProvisioner } from "../main/operatorControl/localAgentHostProvisioner.js";
import { LocalAgentHostRegistrationStore } from "../main/operatorControl/localAgentHostRegistrationStore.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Desktop local Agent Host provisioner", () => {
  it("supports macOS through the platform background capability", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-local-agent-host-macos-"));
    roots.push(root);
    const provisioner = new DesktopLocalAgentHostProvisioner({
      platform: "darwin",
      launcher: { executablePath: "/Applications/PlanWeave.app/PlanWeave" },
      operator: {} as never,
      registrations: new LocalAgentHostRegistrationStore(join(root, "registrations.json"))
    });
    await expect(provisioner.status("profile-a")).resolves.toMatchObject({
      supported: true,
      state: "not_registered"
    });
  });

  it("reports the capability as unavailable when no background adapter exists", async () => {
    const provisioner = new DesktopLocalAgentHostProvisioner({
      platform: "aix",
      launcher: { executablePath: "/opt/PlanWeave/PlanWeave" },
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
      installBackground: vi.fn().mockResolvedValue({
        state: "running",
        platform: "windows-user-startup"
      }),
      listAgents: vi.fn().mockResolvedValue(agents),
      backgroundStatus: vi
        .fn()
        .mockResolvedValue({ state: "running", platform: "windows-user-startup" })
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
      installBackground: false,
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
    await expect(provisioner.status()).resolves.toMatchObject({
      state: "ready",
      workspaceId: "workspace-1",
      agents
    });
  });

  it("installs the background Host after selected Agent exposure is persisted", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-local-agent-host-background-"));
    roots.push(root);
    const registrations = new LocalAgentHostRegistrationStore(join(root, "registrations.json"));
    const agents = [
      {
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Codex",
        detected: true,
        exposed: true,
        ready: true
      }
    ];
    const operator = {
      enrollHandoff: vi.fn().mockResolvedValue({
        state: "ready",
        workspaceId: "workspace-background",
        credential: "active",
        background: "disabled",
        configPath: "C:\\private\\background.json",
        agents: [{ ...agents[0], exposed: false, ready: false }],
        nextSteps: {}
      }),
      reconcileAgentExposure: vi.fn().mockResolvedValue({ agents, reload: "restart_required" }),
      installBackground: vi.fn().mockResolvedValue({
        state: "running",
        platform: "windows-user-startup"
      }),
      listAgents: vi.fn().mockResolvedValue(agents),
      backgroundStatus: vi.fn().mockResolvedValue({
        state: "running",
        platform: "windows-user-startup"
      })
    };
    const launcher = {
      executablePath: "C:\\Program Files\\PlanWeave\\PlanWeave.exe",
      fixedArgs: ["--agent-host-service"]
    };
    const provisioner = new DesktopLocalAgentHostProvisioner({
      platform: "win32",
      launcher,
      operator,
      registrations
    });

    await expect(
      provisioner.register(undefined, "opaque-handoff", ["codex-acp"])
    ).resolves.toMatchObject({
      state: "ready",
      background: "running",
      agents
    });
    expect(operator.enrollHandoff).toHaveBeenCalledWith("opaque-handoff", {
      installBackground: false,
      executablePath: launcher.executablePath,
      fixedArgs: launcher.fixedArgs
    });
    expect(operator.reconcileAgentExposure).toHaveBeenCalledBefore(operator.installBackground);
    expect(operator.installBackground).toHaveBeenCalledWith(
      "C:\\private\\background.json",
      launcher
    );
  });

  it("repairs an enrolled Host without redeeming another handoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-local-agent-host-repair-"));
    roots.push(root);
    const registrations = new LocalAgentHostRegistrationStore(join(root, "registrations.json"));
    await registrations.upsert("profile-a", "workspace-repair");
    const configPath = resolveAgentHostDefaultPaths("workspace-repair").configPath;
    const agents = [
      {
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Codex",
        detected: true,
        exposed: true,
        ready: true
      }
    ];
    const operator = {
      installBackground: vi.fn().mockResolvedValue({
        state: "running",
        platform: "windows-user-startup"
      }),
      listAgents: vi.fn().mockResolvedValue(agents)
    };
    const launcher = {
      executablePath: "C:\\Program Files\\PlanWeave\\PlanWeave.exe",
      fixedArgs: ["--agent-host-service"]
    };
    const provisioner = new DesktopLocalAgentHostProvisioner({
      platform: "win32",
      launcher,
      operator: operator as never,
      registrations
    });

    await expect(provisioner.repair("profile-a")).resolves.toMatchObject({
      state: "ready",
      background: "running",
      workspaceId: "workspace-repair",
      agents
    });
    expect(operator.installBackground).toHaveBeenCalledWith(configPath, launcher);
  });

  it("indexes handoff enrollment by Workspace when no operator profile is present", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-local-agent-host-handoff-"));
    roots.push(root);
    const registrations = new LocalAgentHostRegistrationStore(join(root, "registrations.json"));
    const agents = [
      {
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Codex",
        detected: true,
        exposed: true,
        ready: true
      }
    ];
    const operator = {
      enrollHandoff: vi.fn().mockResolvedValue({
        state: "ready",
        workspaceId: "workspace-handoff",
        credential: "active",
        background: "running",
        configPath: "C:\\private\\handoff.json",
        agents,
        nextSteps: {}
      }),
      reconcileAgentExposure: vi.fn().mockResolvedValue({ agents, reload: "restarted" }),
      installBackground: vi.fn().mockResolvedValue({
        state: "running",
        platform: "windows-user-startup"
      }),
      listAgents: vi.fn().mockResolvedValue(agents),
      backgroundStatus: vi
        .fn()
        .mockResolvedValue({ state: "running", platform: "windows-user-startup" })
    };
    const provisioner = new DesktopLocalAgentHostProvisioner({
      platform: "win32",
      launcher: { executablePath: "C:\\PlanWeave.exe", fixedArgs: ["--agent-host-service"] },
      operator,
      registrations
    });

    await provisioner.register(undefined, "opaque-handoff", ["codex-acp"]);

    await expect(registrations.get("workspace-handoff")).resolves.toMatchObject({
      workspaceId: "workspace-handoff"
    });
    await expect(provisioner.status()).resolves.toMatchObject({
      state: "ready",
      workspaceId: "workspace-handoff"
    });
  });

  it("reports a sanitized enrollment stage and system code", async () => {
    const operator = {
      enrollHandoff: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("private executable path"), { code: "ENOENT" }))
    };
    const provisioner = new DesktopLocalAgentHostProvisioner({
      platform: "win32",
      launcher: { executablePath: "C:\\PlanWeave.exe", fixedArgs: ["--agent-host-service"] },
      operator: operator as never
    });

    await expect(provisioner.register(undefined, "opaque-handoff", ["codex-acp"])).rejects.toThrow(
      "local_agent_host_enrollment_failed_enoent"
    );
  });

  it("reports status-read failures without exposing private process details", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-local-agent-host-status-"));
    roots.push(root);
    const registrations = new LocalAgentHostRegistrationStore(join(root, "registrations.json"));
    await registrations.upsert("workspace-status", "workspace-status");
    const operator = {
      listAgents: vi.fn().mockResolvedValue([]),
      backgroundStatus: vi.fn().mockRejectedValue(new Error("private scheduled task command"))
    };
    const provisioner = new DesktopLocalAgentHostProvisioner({
      platform: "win32",
      launcher: { executablePath: "C:\\PlanWeave.exe", fixedArgs: ["--agent-host-service"] },
      operator: operator as never,
      registrations
    });

    await expect(provisioner.status()).rejects.toThrow(
      "local_agent_host_background_status_read_failed"
    );
  });

  it("treats a registration whose Agent Host config is missing as not registered", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-local-agent-host-orphaned-"));
    roots.push(root);
    const registrations = new LocalAgentHostRegistrationStore(join(root, "registrations.json"));
    await registrations.upsert("workspace-orphaned", "workspace-orphaned");
    const missingConfigError = Object.assign(new Error("private missing config path"), {
      code: "ENOENT"
    });
    const operator = {
      listAgents: vi.fn().mockRejectedValue(missingConfigError),
      backgroundStatus: vi.fn()
    };
    const provisioner = new DesktopLocalAgentHostProvisioner({
      platform: "darwin",
      launcher: { executablePath: "/Applications/PlanWeave.app/PlanWeave" },
      operator: operator as never,
      registrations
    });

    await expect(provisioner.status()).resolves.toMatchObject({
      supported: true,
      state: "not_registered"
    });
    expect(operator.backgroundStatus).not.toHaveBeenCalled();
  });

  it("preserves an existing Agent Host error code", async () => {
    const operator = {
      enrollHandoff: vi.fn().mockRejectedValue(new Error("agent_host_enrollment_rejected"))
    };
    const provisioner = new DesktopLocalAgentHostProvisioner({
      platform: "win32",
      launcher: { executablePath: "C:\\PlanWeave.exe", fixedArgs: ["--agent-host-service"] },
      operator: operator as never
    });

    await expect(provisioner.register(undefined, "opaque-handoff", ["codex-acp"])).rejects.toThrow(
      "agent_host_enrollment_rejected"
    );
  });
});
