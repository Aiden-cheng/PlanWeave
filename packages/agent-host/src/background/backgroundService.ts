export type AgentHostBackgroundState = "running" | "stopped" | "not_installed";

export type AgentHostBackgroundLauncher = {
  executablePath: string;
  fixedArgs?: readonly string[];
};

export type AgentHostBackgroundInstall = AgentHostBackgroundLauncher & {
  workspaceId: string;
  configPath: string;
  privateDirectory: string;
};

export type AgentHostBackgroundGuidance =
  | "enable_user_linger"
  | "check_launch_agent_permissions"
  | "check_scheduled_task_permissions"
  | "configure_ca_certificate"
  | "run_agent_host_manually";

export type AgentHostBackgroundResult = {
  state: AgentHostBackgroundState;
  platform: "linux-systemd-user" | "macos-launch-agent" | "windows-scheduled-task";
  guidance?: AgentHostBackgroundGuidance;
};

export type AgentHostBackgroundLogs =
  | {
      platform: "linux-systemd-user";
      source: "systemd-journal";
      command: { executable: "journalctl"; args: readonly string[] };
    }
  | {
      platform: "macos-launch-agent";
      source: "launch-agent-files";
      stdoutPath: string;
      stderrPath: string;
    }
  | {
      platform: "windows-scheduled-task";
      source: "task-scheduler-diagnostics";
      eventLog: "Microsoft-Windows-TaskScheduler/Operational";
      taskName: string;
      capturesHostStdout: false;
    };

export class AgentHostBackgroundSetupError extends Error {
  readonly code = "agent_host_background_setup_required";

  constructor(
    readonly guidance: AgentHostBackgroundGuidance,
    options?: ErrorOptions
  ) {
    super("agent_host_background_setup_required", options);
  }
}

export interface AgentHostBackgroundService {
  install(input: AgentHostBackgroundInstall): Promise<AgentHostBackgroundResult>;
  uninstall(workspaceId: string): Promise<AgentHostBackgroundResult>;
  status(workspaceId: string): Promise<AgentHostBackgroundResult>;
  restart(workspaceId: string): Promise<AgentHostBackgroundResult>;
  logs(workspaceId: string): Promise<AgentHostBackgroundLogs>;
}
