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
    const sid = await this.currentUserSid();
    await this.runner("icacls.exe", [
      path,
      "/inheritance:r",
      "/grant:r",
      `*${sid}:(OI)(CI)F`,
      "*S-1-5-32-544:(OI)(CI)F"
    ]);
  }

  async secureFile(path: string): Promise<void> {
    const sid = await this.currentUserSid();
    await this.runner("icacls.exe", [
      path,
      "/inheritance:r",
      "/grant:r",
      `*${sid}:F`,
      "*S-1-5-32-544:F"
    ]);
  }

  private async currentUserSid(): Promise<string> {
    const result = await this.runner("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
    const match = result.stdout.match(/S-1-5-[0-9-]+/);
    if (!match) throw new Error("agent_host_windows_user_sid_unavailable");
    return match[0];
  }
}

export function createPrivateStorageSecurity(
  platform: NodeJS.Platform = process.platform
): PrivateStorageSecurityPort {
  return platform === "win32"
    ? new WindowsPrivateStorageSecurity()
    : new PosixPrivateStorageSecurity();
}
