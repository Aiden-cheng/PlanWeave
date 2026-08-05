import type { AgentHostBackgroundService } from "./backgroundService.js";
import { LinuxUserSystemdService } from "./linuxUserSystemd.js";
import { MacosLaunchAgentService } from "./macosLaunchAgent.js";
import { WindowsUserStartupService } from "./windowsUserStartup.js";

export function createPlatformBackgroundService(
  platform: NodeJS.Platform = process.platform
): AgentHostBackgroundService | null {
  if (platform === "linux") return new LinuxUserSystemdService();
  if (platform === "darwin") return new MacosLaunchAgentService();
  if (platform === "win32") return new WindowsUserStartupService();
  return null;
}

export function supportsPlatformBackgroundService(platform: NodeJS.Platform): boolean {
  return createPlatformBackgroundService(platform) !== null;
}
