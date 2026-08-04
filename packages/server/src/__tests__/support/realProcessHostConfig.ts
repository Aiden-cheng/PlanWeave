import { readFile, writeFile } from "node:fs/promises";

type HarnessHostWorkspace = Record<string, unknown> & {
  id: string;
  path: string;
};

type HarnessHostConfig = Record<string, unknown> & {
  workspaces: HarnessHostWorkspace[];
};

function parseHarnessHostConfig(value: unknown): HarnessHostConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("real_process_harness_host_config_invalid");
  }
  const config = value as Record<string, unknown>;
  if (!Array.isArray(config.workspaces) || config.workspaces.length !== 1) {
    throw new Error("real_process_harness_host_config_invalid");
  }
  const workspace = config.workspaces[0];
  if (
    typeof workspace !== "object" ||
    workspace === null ||
    Array.isArray(workspace) ||
    typeof workspace.id !== "string" ||
    typeof workspace.path !== "string"
  ) {
    throw new Error("real_process_harness_host_config_invalid");
  }
  return { ...config, workspaces: [workspace as HarnessHostWorkspace] };
}

export async function configureHostWorkspace(
  configPath: string,
  workspaceId: string
): Promise<void> {
  const rawConfig: unknown = JSON.parse(await readFile(configPath, "utf8"));
  const config = parseHarnessHostConfig(rawConfig);
  const [workspace] = config.workspaces;
  await writeFile(
    configPath,
    JSON.stringify({ ...config, workspaces: [{ ...workspace, id: workspaceId }] }),
    "utf8"
  );
}
