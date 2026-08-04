import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfiguredAcpProfileResolver } from "../config/resolvers.js";
import { parseAgentHostConfig } from "../config/schema.js";
import { writePrivateJsonFile } from "../config/privateConfigWriter.js";
import { AgentHostOperator } from "../operator/agentHostOperator.js";
import {
  listAgentExposure,
  readExposedAgentProfileIds,
  requireSupportedAgentProfile,
  writeExposedAgentProfileIds
} from "../operator/agentExposure.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function config(command = process.execPath) {
  const root = await mkdtemp(join(tmpdir(), "planweave-agent-exposure-"));
  roots.push(root);
  return parseAgentHostConfig({
    version: "agent-host-config/v1",
    coordinator: { url: "https://server.example", allowInsecureDevelopment: false },
    dataDirectory: join(root, "data"),
    workspaceRoot: join(root, "workspaces"),
    host: { displayName: "Host", capacity: 1, capabilities: ["acp.custom"] },
    workspaces: [],
    agentProfiles: [
      {
        id: "custom-acp",
        agentId: "custom",
        command,
        args: [],
        environment: []
      }
    ]
  });
}

describe("Agent exposure allowlist", () => {
  it("initializes a missing allowlist as empty instead of exposing configured profiles", async () => {
    const value = await config();
    await expect(readExposedAgentProfileIds(value)).resolves.toEqual([]);
    await expect(
      readFile(join(value.dataDirectory, "agent-exposure.json"), "utf8")
    ).resolves.toContain('"profileIds": []');
    const restartedConfig = parseAgentHostConfig(JSON.parse(JSON.stringify(value)));
    await expect(readExposedAgentProfileIds(restartedConfig)).resolves.toEqual([]);
  });

  it("hides an explicitly exposed custom profile even after its binary has been uninstalled", async () => {
    const value = await config("/missing/custom-acp");
    const configPath = join(value.dataDirectory, "config.json");
    await writePrivateJsonFile(configPath, value);
    await writeExposedAgentProfileIds(value, ["custom-acp"]);
    await expect(readExposedAgentProfileIds(value)).resolves.toEqual(["custom-acp"]);

    await expect(
      new AgentHostOperator(null).hideAgent(configPath, "custom-acp")
    ).resolves.toMatchObject({
      reload: "restart_required"
    });
    await expect(readExposedAgentProfileIds(value)).resolves.toEqual([]);
    await expect(new AgentHostOperator(null).listAgents(configPath)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ exposed: false, ready: false })])
    );
  });

  it("explicitly exposes an existing profile that uses an absolute command", async () => {
    const base = await config();
    const value = parseAgentHostConfig({
      ...base,
      agentProfiles: [
        {
          id: "codex-acp",
          agentId: "codex",
          command: process.execPath,
          args: [],
          environment: []
        }
      ]
    });
    const configPath = join(value.dataDirectory, "config.json");
    await writePrivateJsonFile(configPath, value);

    const result = await new AgentHostOperator(null, "linux", {}).exposeAgent(
      configPath,
      "codex-acp"
    );

    expect(result.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ profileId: "codex-acp", exposed: true, ready: true })
      ])
    );
    await expect(readExposedAgentProfileIds(value)).resolves.toEqual(["codex-acp"]);
  });

  it("validates and replaces the complete exposed profile set before one reload", async () => {
    const base = await config();
    const value = parseAgentHostConfig({
      ...base,
      agentProfiles: [
        ...base.agentProfiles,
        {
          id: "codex-acp",
          agentId: "codex",
          command: process.execPath,
          args: [],
          environment: []
        }
      ]
    });
    const configPath = join(value.dataDirectory, "config.json");
    await writePrivateJsonFile(configPath, value);
    await writeExposedAgentProfileIds(value, ["custom-acp"]);

    const result = await new AgentHostOperator(null, "linux", {}).reconcileAgentExposure(
      configPath,
      ["codex-acp"]
    );

    expect(result).toMatchObject({ reload: "restart_required" });
    await expect(readExposedAgentProfileIds(value)).resolves.toEqual(["codex-acp"]);
    await expect(
      new AgentHostOperator(null, "linux", {}).reconcileAgentExposure(configPath, ["unknown-acp"])
    ).rejects.toThrow("agent_host_agent_profile_unsupported");
    await expect(readExposedAgentProfileIds(value)).resolves.toEqual(["codex-acp"]);
  });

  it("enforces exposure dynamically at execution resolution without a daemon restart", async () => {
    const value = await config();
    const resolver = new ConfiguredAcpProfileResolver(value, process.env, async (agentProfileId) =>
      (await readExposedAgentProfileIds(value)).includes(agentProfileId)
    );

    await writeExposedAgentProfileIds(value, []);
    await expect(resolver.resolve("custom-acp", "custom")).rejects.toThrow(
      "agent_host_profile_not_exposed"
    );

    await writeExposedAgentProfileIds(value, ["custom-acp"]);
    await expect(resolver.resolve("custom-acp", "custom")).resolves.toMatchObject({
      agentId: "custom"
    });

    await writeExposedAgentProfileIds(value, []);
    await expect(resolver.resolve("custom-acp", "custom")).rejects.toThrow(
      "agent_host_profile_not_exposed"
    );
  });

  it("lists only safe supported registry metadata", async () => {
    const value = await config();
    await writeExposedAgentProfileIds(value, []);
    const listed = await listAgentExposure(value, async () => process.execPath);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((profile) => profile.detected && !profile.exposed && !profile.ready)).toBe(
      true
    );
    expect(JSON.stringify(listed)).not.toMatch(/command|environment|token|\/Users\//i);
  });

  it("initializes, detects, and exposes a Windows npm ACP shim by absolute path", async () => {
    const binaryRoot = await mkdtemp(join(tmpdir(), "planweave-agent-exposure-win32-"));
    roots.push(binaryRoot);
    const commandPath = join(binaryRoot, "codex-acp.cmd");
    await writeFile(commandPath, "@echo off\r\n", "utf8");
    const value = await config();
    const configPath = join(value.dataDirectory, "config.json");
    await writePrivateJsonFile(configPath, value);
    const operator = new AgentHostOperator(null, "win32", {
      Path: binaryRoot,
      PATHEXT: ".CMD",
      NoDefaultCurrentDirectoryInExePath: "1"
    });

    const initialized = await operator.initializePreset(configPath, "codex-acp");
    const canonicalCommandPath = await realpath(commandPath);
    expect(initialized.agentProfiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "codex-acp", command: canonicalCommandPath })
      ])
    );
    await expect(operator.listAgents(configPath)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profileId: "codex-acp",
          detected: true,
          exposed: false,
          ready: false
        })
      ])
    );

    const exposed = await operator.exposeAgent(configPath, "codex-acp");
    expect(exposed.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ profileId: "codex-acp", exposed: true, ready: true })
      ])
    );
    const persisted = JSON.parse(await readFile(configPath, "utf8")) as {
      agentProfiles: Array<{ id: string; command: string }>;
    };
    expect(persisted.agentProfiles.find((profile) => profile.id === "codex-acp")?.command).toBe(
      canonicalCommandPath
    );
  });

  it("fails closed for unknown profile ids", () => {
    expect(() => requireSupportedAgentProfile("custom-acp")).toThrow(
      "agent_host_agent_profile_unsupported"
    );
  });

  it("does not restart the background task after a credential is revoked", async () => {
    const value = await config();
    const configPath = join(value.dataDirectory, "config.json");
    await writePrivateJsonFile(configPath, value);
    await mkdir(value.dataDirectory, { recursive: true, mode: 0o700 });
    await writePrivateJsonFile(join(value.dataDirectory, "credentials.json"), {
      version: "agent-host-credentials/v1",
      active: {
        hostId: "host-revoked",
        workspaceId: "workspace-revoked",
        credentialToken: `pw_host_${"a".repeat(43)}`,
        issuedAt: "2029-01-01T00:00:00.000Z",
        expiresAt: "2030-01-01T00:00:00.000Z",
        revokedAt: "2029-01-02T00:00:00.000Z"
      }
    });
    const background = {
      install: vi.fn(),
      uninstall: vi.fn(),
      status: vi.fn().mockResolvedValue({
        state: "running",
        platform: "linux-systemd-user"
      }),
      restart: vi.fn(),
      logs: vi.fn()
    };

    const operator = new AgentHostOperator(background);
    await expect(operator.restartBackground(configPath)).rejects.toThrow(
      "agent_host_credential_unavailable"
    );
    await expect(operator.hideAgent(configPath, "custom-acp")).resolves.toMatchObject({
      reload: "restart_required"
    });
    expect(background.status).not.toHaveBeenCalled();
    expect(background.restart).not.toHaveBeenCalled();
  });
});
