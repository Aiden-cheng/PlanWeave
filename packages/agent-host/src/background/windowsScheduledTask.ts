import type {
  AgentHostBackgroundInstall,
  AgentHostBackgroundResult,
  AgentHostBackgroundService
} from "./backgroundService.js";
import { AgentHostBackgroundSetupError } from "./backgroundService.js";
import { runFixedArgv, type FixedArgvRunner } from "./processRunner.js";

function taskName(workspaceId: string): string {
  return `PlanWeave Agent Host ${workspaceId.replace(/[^A-Za-z0-9_.-]/g, "-")}`;
}

function quoteWindowsCommand(value: string): string {
  if ([...value].some((character) => [0, 10, 13].includes(character.codePointAt(0) ?? -1))) {
    throw new Error("agent_host_background_task_value_invalid");
  }
  const escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1");
  return `"${escaped}"`;
}

function taskCommand(input: AgentHostBackgroundInstall): string {
  return [input.executablePath, ...(input.fixedArgs ?? []), "run", "--config", input.configPath]
    .map(quoteWindowsCommand)
    .join(" ");
}

function processErrorCode(error: unknown): number | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "number"
    ? error.code
    : undefined;
}

export class WindowsScheduledTaskService implements AgentHostBackgroundService {
  constructor(private readonly runner: FixedArgvRunner = runFixedArgv) {}

  async install(input: AgentHostBackgroundInstall): Promise<AgentHostBackgroundResult> {
    try {
      await this.runner("schtasks.exe", [
        "/Create",
        "/TN",
        taskName(input.workspaceId),
        "/SC",
        "ONLOGON",
        "/RL",
        "LIMITED",
        "/TR",
        taskCommand(input),
        "/F"
      ]);
      await this.runner("schtasks.exe", ["/Run", "/TN", taskName(input.workspaceId)]);
      return { state: "running", platform: "windows-scheduled-task" };
    } catch (error) {
      throw new AgentHostBackgroundSetupError("check_scheduled_task_permissions", {
        cause: error
      });
    }
  }

  async uninstall(workspaceId: string): Promise<AgentHostBackgroundResult> {
    try {
      await this.runner("schtasks.exe", ["/Delete", "/TN", taskName(workspaceId), "/F"]);
    } catch (error) {
      if (processErrorCode(error) !== 1) throw error;
    }
    return { state: "not_installed", platform: "windows-scheduled-task" };
  }

  async status(workspaceId: string): Promise<AgentHostBackgroundResult> {
    try {
      const result = await this.runner("schtasks.exe", [
        "/Query",
        "/TN",
        taskName(workspaceId),
        "/FO",
        "CSV",
        "/NH"
      ]);
      return {
        state: /running/i.test(result.stdout) ? "running" : "stopped",
        platform: "windows-scheduled-task"
      };
    } catch (error) {
      if (processErrorCode(error) === 1) {
        return { state: "not_installed", platform: "windows-scheduled-task" };
      }
      throw error;
    }
  }

  async restart(workspaceId: string): Promise<AgentHostBackgroundResult> {
    const status = await this.status(workspaceId);
    if (status.state === "not_installed") return status;
    if (status.state === "running") {
      await this.runner("schtasks.exe", ["/End", "/TN", taskName(workspaceId)]);
    }
    await this.runner("schtasks.exe", ["/Run", "/TN", taskName(workspaceId)]);
    return { state: "running", platform: "windows-scheduled-task" };
  }
}

export { taskCommand as windowsAgentHostTaskCommand, taskName as windowsAgentHostTaskName };
