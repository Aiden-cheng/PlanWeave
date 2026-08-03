import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  it("migrates configured legacy profiles once to a durable explicit allowlist", async () => {
    const value = await config();
    await expect(readExposedAgentProfileIds(value)).resolves.toEqual(["custom-acp"]);
    await expect(
      readFile(join(value.dataDirectory, "agent-exposure.json"), "utf8")
    ).resolves.toContain('"custom-acp"');
    const restartedConfig = parseAgentHostConfig(JSON.parse(JSON.stringify(value)));
    await expect(readExposedAgentProfileIds(restartedConfig)).resolves.toEqual(["custom-acp"]);
  });

  it("hides a migrated custom profile even after its binary has been uninstalled", async () => {
    const value = await config("/missing/custom-acp");
    const configPath = join(value.dataDirectory, "config.json");
    await writePrivateJsonFile(configPath, value);
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

  it("fails closed for unknown profile ids", () => {
    expect(() => requireSupportedAgentProfile("custom-acp")).toThrow(
      "agent_host_agent_profile_unsupported"
    );
  });
});
