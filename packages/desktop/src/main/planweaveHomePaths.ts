import { join } from "node:path";
import { homedir } from "node:os";
import { resolvePlanweaveHome } from "@planweave-ai/runtime";

export type DesktopHomePaths = {
  planweaveHome: string;
  desktopSettingsFile: string;
  terminalPreferencesFile: string;
  mcpTunnelDir: string;
  mcpTunnelConfigFile: string;
  mcpTunnelDownloadsDir: string;
  collaborationDir: string;
  collaborationProfilesFile: string;
  collaborationCredentialsFile: string;
  operatorControlDir: string;
  operatorProfilesFile: string;
  operatorCredentialsFile: string;
};

export function desktopHomePaths(): DesktopHomePaths {
  const planweaveHome = resolvePlanweaveHome();
  const desktopSettingsHome = join(homedir(), ".planweave");
  const mcpTunnelDir = join(planweaveHome, "desktop", "mcp-tunnel");
  const collaborationDir = join(planweaveHome, "desktop", "collaboration");
  const operatorControlDir = join(planweaveHome, "desktop", "operator-control");
  return {
    planweaveHome,
    desktopSettingsFile: join(desktopSettingsHome, "config", "desktop-settings.json"),
    terminalPreferencesFile: join(planweaveHome, "config", "terminal-preferences.json"),
    mcpTunnelDir,
    mcpTunnelConfigFile: join(mcpTunnelDir, "config.json"),
    mcpTunnelDownloadsDir: join(mcpTunnelDir, "downloads"),
    collaborationDir,
    collaborationProfilesFile: join(collaborationDir, "profiles.json"),
    collaborationCredentialsFile: join(collaborationDir, "credentials.json"),
    operatorControlDir,
    operatorProfilesFile: join(operatorControlDir, "profiles.json"),
    operatorCredentialsFile: join(operatorControlDir, "credentials.json")
  };
}
