export type AgentHostBackgroundState = "running" | "stopped" | "not_installed";

export type AgentHostBackgroundInstall = {
  workspaceId: string;
  executablePath: string;
  configPath: string;
  privateDirectory: string;
};

export type AgentHostBackgroundResult = {
  state: AgentHostBackgroundState;
  platform: "linux-systemd-user" | "windows-scheduled-task";
  guidance?: "enable_user_linger" | "run_agent_host_manually";
};

export interface AgentHostBackgroundService {
  install(input: AgentHostBackgroundInstall): Promise<AgentHostBackgroundResult>;
  uninstall(workspaceId: string): Promise<AgentHostBackgroundResult>;
  status(workspaceId: string): Promise<AgentHostBackgroundResult>;
  restart(workspaceId: string): Promise<AgentHostBackgroundResult>;
}
