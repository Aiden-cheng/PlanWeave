import type { AgentHostBackgroundService } from "./backgroundService.js";
import { LinuxUserSystemdService } from "./linuxUserSystemd.js";
import { WindowsScheduledTaskService } from "./windowsScheduledTask.js";

export function createPlatformBackgroundService(
  platform: NodeJS.Platform = process.platform
): AgentHostBackgroundService | null {
  if (platform === "linux") return new LinuxUserSystemdService();
  if (platform === "win32") return new WindowsScheduledTaskService();
  return null;
}
