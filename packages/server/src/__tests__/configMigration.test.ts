import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashOperatorToken } from "../operatorAuth.js";
import { parseServerConfig } from "../config.js";
import { migrateServerConfigFile } from "../configMigration.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function fixture(mode: "loopback" | "lan" | "direct") {
  const root = await mkdtemp(join(tmpdir(), "planweave-server-config-migration-"));
  directories.push(root);
  const configPath = join(root, "server.json");
  const direct = mode === "direct";
  const serverOrigin = direct
    ? "https://planweave.example.com"
    : mode === "lan"
      ? "http://192.168.1.20:7443"
      : "http://127.0.0.1:7443";
  const input = {
    version: "server-config/v1",
    bind: { host: mode === "loopback" ? "127.0.0.1" : "0.0.0.0", port: direct ? 443 : 7_443 },
    publicUrl: serverOrigin,
    ...(direct
      ? {
          deployment: {
            topology: "public_https",
            serverOrigin,
            allowedClientOrigins: [serverOrigin],
            tlsTrust: "system_ca"
          },
          tls: {
            certificatePath: join(root, "server.crt"),
            privateKeyPath: join(root, "server.key")
          }
        }
      : {}),
    allowInsecureDevelopment: !direct,
    allowInsecureLan: mode === "lan",
    dataDirectory: join(root, "data"),
    trustedProjects: [
      {
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "default",
        projectRoot: root
      }
    ],
    operatorCredentials: [
      {
        operatorId: "admin",
        tokenSha256: hashOperatorToken(`pw_operator_${"M".repeat(43)}`),
        projectIds: [],
        serverAdmin: true
      }
    ]
  };
  await writeFile(configPath, `${JSON.stringify(input, null, 2)}\n`, { mode: 0o640 });
  await chmod(configPath, 0o640);
  return { root, configPath };
}

describe("server config migration", () => {
  it.each([
    ["loopback", "loopback_http", "http", "127.0.0.1", 7_443, "http://127.0.0.1:7443"],
    ["lan", "lan_http", "http", "0.0.0.0", 7_443, "http://192.168.1.20:7443"],
    ["direct", "direct_https", "https", "0.0.0.0", 443, "https://planweave.example.com"]
  ] as const)("atomically rewrites %s v1 without changing its transport", async (sourceMode, transportMode, protocol, host, port, advertisedOrigin) => {
    const { root, configPath } = await fixture(sourceMode);
    const sourceMetadata = await stat(configPath);

    await expect(migrateServerConfigFile(configPath)).resolves.toEqual({
      schemaVersion: "server-config-migration/v1",
      configPath,
      fromVersion: "server-config/v1",
      toVersion: "server-config/v2",
      changed: true
    });

    const bytes = await readFile(configPath, "utf8");
    const migrated: unknown = JSON.parse(bytes);
    const parsed = parseServerConfig(migrated);
    expect(parsed.transport).toMatchObject({
      mode: transportMode,
      listener: { protocol, host, port },
      advertisedOrigin
    });
    if (sourceMode === "direct") {
      expect(parsed).toMatchObject({
        deployment: {
          topology: "public_https",
          serverOrigin: advertisedOrigin,
          allowedClientOrigins: [advertisedOrigin]
        },
        allowedClientOrigins: [advertisedOrigin]
      });
      expect(parsed.transport.listener).toMatchObject({
        tls: {
          certificatePath: join(root, "server.crt"),
          privateKeyPath: join(root, "server.key")
        }
      });
    }
    expect(migrated).not.toHaveProperty("bind");
    expect(migrated).not.toHaveProperty("publicUrl");
    const migratedMetadata = await stat(configPath);
    expect(migratedMetadata.mode & 0o777).toBe(0o640);
    if (process.platform !== "win32") {
      expect({ uid: migratedMetadata.uid, gid: migratedMetadata.gid }).toEqual({
        uid: sourceMetadata.uid,
        gid: sourceMetadata.gid
      });
    }
    expect((await readdir(root)).filter((entry) => entry.endsWith(".migrate"))).toEqual([]);

    await expect(migrateServerConfigFile(configPath)).resolves.toMatchObject({
      fromVersion: "server-config/v2",
      changed: false
    });
    await expect(readFile(configPath, "utf8")).resolves.toBe(bytes);
  });

  it("preserves an invalid source file and does not leave a staged replacement", async () => {
    const { root, configPath } = await fixture("loopback");
    const invalid = '{"version":"server-config/v1","dataDirectory":"relative"}\n';
    await writeFile(configPath, invalid, "utf8");

    await expect(migrateServerConfigFile(configPath)).rejects.toThrow("server_config_invalid");
    await expect(readFile(configPath, "utf8")).resolves.toBe(invalid);
    expect((await readdir(root)).filter((entry) => entry.endsWith(".migrate"))).toEqual([]);
  });

  it.runIf(process.platform !== "win32")(
    "rejects symbolic links without changing their target",
    async () => {
      const { root, configPath } = await fixture("loopback");
      const linkPath = join(root, "server-link.json");
      const source = await readFile(configPath, "utf8");
      await symlink(configPath, linkPath);

      await expect(migrateServerConfigFile(linkPath)).rejects.toThrow(
        "server_config_path_symlink_not_allowed"
      );
      await expect(readFile(configPath, "utf8")).resolves.toBe(source);
    }
  );

  it("returns stable errors for missing and non-file paths", async () => {
    const { root } = await fixture("loopback");
    await expect(migrateServerConfigFile(join(root, "missing.json"))).rejects.toThrow(
      "server_config_path_not_found"
    );
    await expect(migrateServerConfigFile(root)).rejects.toThrow("server_config_path_not_file");
  });
});
