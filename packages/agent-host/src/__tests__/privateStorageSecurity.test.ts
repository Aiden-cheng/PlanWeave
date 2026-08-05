import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writePrivateJsonFile } from "../config/privateConfigWriter.js";
import { FileHostCredentialStore } from "../credentials/fileCredentialStore.js";
import {
  WindowsPrivateStorageSecurity,
  type PrivateStorageSecurityPort
} from "../storage/privateStorageSecurity.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      if (args[1] === "r") {
        throw Object.assign(new Error("EPERM: operation not permitted, fsync"), {
          code: "EPERM",
          errno: -4048,
          syscall: "fsync"
        });
      }
      return actual.open(...args);
    })
  };
});

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

function windowsSecurity() {
  const runner = vi
    .fn()
    .mockResolvedValueOnce({ stdout: '"USER","S-1-5-21-123"\n', stderr: "" })
    .mockResolvedValueOnce({ stdout: "", stderr: "" })
    .mockResolvedValueOnce({ stdout: '"USER","S-1-5-21-123"\n', stderr: "" })
    .mockResolvedValueOnce({ stdout: "", stderr: "" });
  return { runner, security: new WindowsPrivateStorageSecurity(runner) };
}

const pendingCredential = {
  kind: "host_enrollment_code" as const,
  enrollmentAttemptId: "attempt-windows-durability",
  enrollmentCode: `pw_enroll_${"a".repeat(43)}`,
  credentialToken: `pw_host_${"b".repeat(43)}`,
  createdAt: "2029-01-01T00:00:00.000Z"
};

describe("private storage security port", () => {
  it("atomically completes concurrent writes to the same first-use path", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-private-concurrent-"));
    directories.push(root);
    const path = join(root, "private", "migration.json");
    const candidates = Array.from({ length: 32 }, (_, index) => ({
      version: "migration/v1",
      index,
      payload: String(index).repeat(1_024)
    }));
    await mkdir(join(root, "private"), { recursive: true });
    const barrier = Promise.withResolvers<void>();
    let arrivals = 0;
    const security: PrivateStorageSecurityPort = {
      permissionModel: "posix",
      prepareDirectory: async () => {
        arrivals += 1;
        if (arrivals === candidates.length) barrier.resolve();
        await barrier.promise;
      },
      secureFile: async () => undefined
    };
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);

    await expect(
      Promise.all(candidates.map((candidate) => writePrivateJsonFile(path, candidate, security)))
    ).resolves.toHaveLength(candidates.length);

    const written: unknown = JSON.parse(await readFile(path, "utf8"));
    expect(candidates).toContainEqual(written);
    expect((await readdir(join(root, "private"))).filter((name) => name.includes(".tmp-"))).toEqual(
      []
    );
  });

  it("secures config directory inheritance and the renamed config file with the current SID", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-private-config-"));
    directories.push(root);
    const { runner, security } = windowsSecurity();
    const path = join(root, "private", "config.json");
    await writePrivateJsonFile(path, { safe: true }, security);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ safe: true });
    expect(runner).toHaveBeenNthCalledWith(
      2,
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        expect.stringContaining("SetSecurityDescriptorSddlForm")
      ],
      {
        environment: {
          PLANWEAVE_PRIVATE_STORAGE_PATH: join(root, "private"),
          PLANWEAVE_PRIVATE_STORAGE_SID: "S-1-5-21-123",
          PLANWEAVE_PRIVATE_STORAGE_KIND: "directory"
        }
      }
    );
    const directoryAclScript = runner.mock.calls[1]?.[1]?.[3];
    expect(directoryAclScript).toContain("System.Security.AccessControl.DirectorySecurity");
    expect(directoryAclScript).toContain("System.Security.AccessControl.FileSecurity");
    expect(directoryAclScript).toContain("$target.SetAccessControl($acl)");
    expect(directoryAclScript).not.toContain("Get-Acl");
    expect(directoryAclScript).not.toContain("Set-Acl");
    expect(directoryAclScript).toContain("D:P");
    expect(runner).toHaveBeenNthCalledWith(
      4,
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        expect.stringContaining("SetSecurityDescriptorSddlForm")
      ],
      {
        environment: {
          PLANWEAVE_PRIVATE_STORAGE_PATH: path,
          PLANWEAVE_PRIVATE_STORAGE_SID: "S-1-5-21-123",
          PLANWEAVE_PRIVATE_STORAGE_KIND: "file"
        }
      }
    );
  });

  it("passes paths with shell metacharacters as a single fixed argument", async () => {
    const runner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '"USER","S-1-5-21-123"\n', stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const security = new WindowsPrivateStorageSecurity(runner);
    const path = 'C:\\private & whoami | powershell -Command "bad"';

    await security.secureFile(path);

    expect(runner).toHaveBeenNthCalledWith(1, "whoami.exe", ["/user", "/fo", "csv", "/nh"]);
    expect(runner).toHaveBeenNthCalledWith(
      2,
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        expect.stringContaining("SetSecurityDescriptorSddlForm")
      ],
      {
        environment: {
          PLANWEAVE_PRIVATE_STORAGE_PATH: path,
          PLANWEAVE_PRIVATE_STORAGE_SID: "S-1-5-21-123",
          PLANWEAVE_PRIVATE_STORAGE_KIND: "file"
        }
      }
    );
  });

  it("uses the same security port for credential directory and final credential file", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-private-credential-"));
    directories.push(root);
    const { runner, security } = windowsSecurity();
    const store = new FileHostCredentialStore(
      join(root, "credentials", "credentials.json"),
      security
    );
    await store.begin(
      {
        kind: "host_enrollment_code",
        enrollmentAttemptId: "attempt-1",
        enrollmentCode: `pw_enroll_${"a".repeat(43)}`,
        credentialToken: `pw_host_${"b".repeat(43)}`,
        createdAt: "2029-01-01T00:00:00.000Z"
      },
      false
    );
    expect(runner).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(runner.mock.calls)).not.toContain("pw_host_");
  });

  it("reapplies the private directory policy before writing into an existing directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-private-existing-"));
    directories.push(root);
    const directory = join(root, "credentials");
    await mkdir(directory, { recursive: true });
    const prepareDirectory = vi.fn();
    const security: PrivateStorageSecurityPort = {
      permissionModel: "windows-acl",
      prepareDirectory,
      secureFile: vi.fn()
    };
    const store = new FileHostCredentialStore(join(directory, "credentials.json"), security);

    await store.begin(
      {
        kind: "host_enrollment_code",
        enrollmentAttemptId: "attempt-existing",
        enrollmentCode: `pw_enroll_${"c".repeat(43)}`,
        credentialToken: `pw_host_${"d".repeat(43)}`,
        createdAt: "2029-01-01T00:00:00.000Z"
      },
      false
    );

    expect(prepareDirectory).toHaveBeenCalledWith(directory);
  });

  it("commits credentials when Windows rejects POSIX parent-directory fsync", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-windows-credential-"));
    directories.push(root);
    const security: PrivateStorageSecurityPort = {
      permissionModel: "windows-acl",
      prepareDirectory: async (path) => mkdir(path, { recursive: true }),
      secureFile: vi.fn(async () => undefined)
    };
    const path = join(root, "credentials", "credentials.json");
    const store = new FileHostCredentialStore(path, security);

    await store.begin(pendingCredential, false);

    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: "agent-host-credentials/v1",
      pending: { enrollmentAttemptId: pendingCredential.enrollmentAttemptId }
    });
  });

  it("still treats a POSIX parent-directory fsync failure as a failed commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-posix-credential-"));
    directories.push(root);
    const security: PrivateStorageSecurityPort = {
      permissionModel: "posix",
      prepareDirectory: async (path) => {
        await mkdir(path, { recursive: true, mode: 0o700 });
        await chmod(path, 0o700);
      },
      secureFile: async (path) => chmod(path, 0o600)
    };
    const store = new FileHostCredentialStore(
      join(root, "credentials", "credentials.json"),
      security
    );

    await expect(store.begin(pendingCredential, false)).rejects.toThrow(
      "agent_host_credential_commit_durability_failed"
    );
  });
});
