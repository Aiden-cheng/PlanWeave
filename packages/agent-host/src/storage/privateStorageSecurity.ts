import { chmod, mkdir } from "node:fs/promises";
import { runFixedArgv, type FixedArgvRunner } from "../background/processRunner.js";

export interface PrivateStorageSecurityPort {
  readonly permissionModel: "posix" | "windows-acl";
  prepareDirectory(path: string): Promise<void>;
  secureFile(path: string): Promise<void>;
}

export class PosixPrivateStorageSecurity implements PrivateStorageSecurityPort {
  readonly permissionModel = "posix" as const;
  async prepareDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }

  async secureFile(path: string): Promise<void> {
    await chmod(path, 0o600);
  }
}

export class WindowsPrivateStorageSecurity implements PrivateStorageSecurityPort {
  readonly permissionModel = "windows-acl" as const;
  constructor(private readonly runner: FixedArgvRunner = runFixedArgv) {}

  async prepareDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
    await this.replaceAccessControl(path, "directory");
  }

  async secureFile(path: string): Promise<void> {
    await this.replaceAccessControl(path, "file");
  }

  private async replaceAccessControl(path: string, kind: "directory" | "file"): Promise<void> {
    const sid = await this.currentUserSid();
    await this.runner(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", REPLACE_ACCESS_CONTROL_SCRIPT],
      {
        environment: {
          PLANWEAVE_PRIVATE_STORAGE_PATH: path,
          PLANWEAVE_PRIVATE_STORAGE_SID: sid,
          PLANWEAVE_PRIVATE_STORAGE_KIND: kind
        }
      }
    );
  }

  private async currentUserSid(): Promise<string> {
    const result = await this.runner("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
    const match = result.stdout.match(/S-1-5-[0-9-]+/);
    if (!match) throw new Error("agent_host_windows_user_sid_unavailable");
    return match[0];
  }
}

const REPLACE_ACCESS_CONTROL_SCRIPT = [
  "$ErrorActionPreference='Stop';",
  "$path=$env:PLANWEAVE_PRIVATE_STORAGE_PATH;",
  "$sid=$env:PLANWEAVE_PRIVATE_STORAGE_SID;",
  "$isDirectory=$env:PLANWEAVE_PRIVATE_STORAGE_KIND -eq 'directory';",
  "$flags=if($isDirectory){'OICI'}else{''};",
  "$sddl='D:P(A;'+$flags+';FA;;;'+$sid+')(A;'+$flags+';FA;;;S-1-5-32-544)';",
  "$acl=if($isDirectory){New-Object System.Security.AccessControl.DirectorySecurity}else{New-Object System.Security.AccessControl.FileSecurity};",
  "$acl.SetSecurityDescriptorSddlForm($sddl,[System.Security.AccessControl.AccessControlSections]::Access);",
  "$target=if($isDirectory){New-Object System.IO.DirectoryInfo($path)}else{New-Object System.IO.FileInfo($path)};",
  "$target.SetAccessControl($acl)"
].join("");

export function createPrivateStorageSecurity(
  platform: NodeJS.Platform = process.platform
): PrivateStorageSecurityPort {
  return platform === "win32"
    ? new WindowsPrivateStorageSecurity()
    : new PosixPrivateStorageSecurity();
}
