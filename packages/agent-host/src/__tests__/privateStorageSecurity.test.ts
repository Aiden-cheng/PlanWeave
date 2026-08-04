import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writePrivateJsonFile } from "../config/privateConfigWriter.js";
import { FileHostCredentialStore } from "../credentials/fileCredentialStore.js";
import {
  WindowsPrivateStorageSecurity,
  type PrivateStorageSecurityPort
} from "../storage/privateStorageSecurity.js";

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
    expect(runner).toHaveBeenNthCalledWith(2, "icacls.exe", [
      join(root, "private"),
      "/inheritance:r",
      "/grant:r",
      "*S-1-5-21-123:(OI)(CI)F",
      "*S-1-5-32-544:(OI)(CI)F"
    ]);
    expect(runner).toHaveBeenNthCalledWith(4, "icacls.exe", [
      path,
      "/inheritance:r",
      "/grant:r",
      "*S-1-5-21-123:F",
      "*S-1-5-32-544:F"
    ]);
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
    expect(runner).toHaveBeenNthCalledWith(2, "icacls.exe", [
      path,
      "/inheritance:r",
      "/grant:r",
      "*S-1-5-21-123:F",
      "*S-1-5-32-544:F"
    ]);
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
});
