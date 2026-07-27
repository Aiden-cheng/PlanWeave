import { createServer, type Server as HttpServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlanPackageManifest } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  basicManifest,
  createTestWorkspace,
  writePromptFiles
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import {
  canonicalProjectCanvasNode,
  loadProjectGraph,
  projectCanvasWorkspace,
  writeProjectGraph
} from "../../../runtime/src/projectGraph/index.js";
import { writeJsonFile } from "../../../runtime/src/json.js";
import { parseServerConfig } from "../config.js";
import { hashOperatorToken } from "../operatorAuth.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { createDistributedServerComposition } from "../serverComposition.js";
import { openServerDatabase } from "../sqlite.js";

const httpServers: HttpServer[] = [];
const compositions: Array<Awaited<ReturnType<typeof createDistributedServerComposition>>> = [];
const directories: string[] = [];
const adminToken = `pw_operator_${"A".repeat(43)}`;

afterEach(async () => {
  for (const composition of compositions.splice(0)) await composition.close();
  await Promise.all(
    httpServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function remoteManifest(): PlanPackageManifest {
  const manifest = basicManifest();
  manifest.execution.defaultExecutor = "codex-acp";
  manifest.executors = {
    "codex-acp": { adapter: "agent", agent: "codex", runner: { transport: "acp" } }
  };
  return manifest;
}

async function addSecondaryCanvas(root: string): Promise<void> {
  const loaded = await loadProjectGraph(root);
  const secondaryCanvas = canonicalProjectCanvasNode({
    id: "secondary",
    title: "Secondary canvas"
  });
  const secondaryWorkspace = projectCanvasWorkspace(loaded.workspace, secondaryCanvas);
  const manifest = remoteManifest();
  await mkdir(secondaryWorkspace.packageDir, { recursive: true });
  await writeJsonFile(secondaryWorkspace.manifestFile, manifest);
  await writePromptFiles(secondaryWorkspace.packageDir, manifest);
  await writeFile(secondaryWorkspace.stateFile, await readFile(loaded.workspace.stateFile));
  await mkdir(secondaryWorkspace.resultsDir, { recursive: true });
  await writeProjectGraph(loaded.workspace, {
    version: "plan-project/v1",
    canvases: [
      canonicalProjectCanvasNode({ id: "default", title: "Default canvas" }),
      secondaryCanvas
    ],
    edges: [],
    crossTaskEdges: []
  });
}

async function startComposition(
  projectRoot: string,
  dataDirectory: string,
  projectId: string,
  trustAllDeclaredCanvases: boolean
) {
  const httpServer = createServer();
  httpServers.push(httpServer);
  const config = parseServerConfig({
    version: "server-config/v1",
    bind: { host: "127.0.0.1", port: 7_443 },
    publicUrl: "http://127.0.0.1:7443",
    allowInsecureDevelopment: true,
    dataDirectory,
    trustedProjects: [
      trustAllDeclaredCanvases
        ? { projectId, projectRoot, trustAllDeclaredCanvases: true }
        : { projectId, projectRoot, canvasId: "default" }
    ],
    operatorCredentials: [
      {
        operatorId: "admin",
        tokenSha256: hashOperatorToken(adminToken),
        projectIds: [],
        serverAdmin: true
      }
    ]
  });
  const composition = await createDistributedServerComposition({ httpServer, config });
  compositions.push(composition);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP address");
  return { composition, origin: `http://127.0.0.1:${address.port}` };
}

describe("distributed server ACL migration recovery", () => {
  it("repairs partial startup migration and preserves package bytes", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    await addSecondaryCanvas(workspace.root);
    const projectId = workspace.init.workspace.id;
    const dataDirectory = join(workspace.root, "migration-recovery-data");
    const loaded = await loadProjectGraph(workspace.root);
    const defaultCanvas = loaded.manifest.canvases.find((canvas) => canvas.id === "default");
    const secondaryCanvas = loaded.manifest.canvases.find((canvas) => canvas.id === "secondary");
    if (!defaultCanvas || !secondaryCanvas) throw new Error("Expected Runtime canvases");
    const defaultWorkspace = projectCanvasWorkspace(loaded.workspace, defaultCanvas);
    const beforeManifest = await readFile(defaultWorkspace.manifestFile);
    const beforeState = await readFile(defaultWorkspace.stateFile);
    const resultPath = join(defaultWorkspace.resultsDir, "recovery-result.json");
    await writeFile(resultPath, '{"result":"preserve"}\n', "utf8");
    const beforeResults = await readFile(resultPath);

    const first = await startComposition(workspace.root, dataDirectory, projectId, true);
    const bootstrap = await fetch(`${first.origin}/api/v1/projects/${projectId}/human/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Trusted Owner", humanPrincipalId: "trusted-owner" })
    });
    expect(bootstrap.status).toBe(201);
    const { deviceToken } = (await bootstrap.json()) as { deviceToken: string };
    await first.composition.close();
    compositions.splice(compositions.indexOf(first.composition), 1);

    const databasePath = join(dataDirectory, "planweave-server.sqlite");
    const database = await openServerDatabase(databasePath, 5_000);
    const workspaceId = new WorkspaceIdentityRepository(database).workspaceForLegacyProject(
      projectId
    );
    if (!workspaceId) throw new Error("Expected workspace mapping");
    database
      .prepare(
        `UPDATE acl_registry_migrations
         SET marker='path_bound',status='interrupted',failure_code='simulated_crash'
         WHERE workspace_id=? AND project_id=? AND canvas_id IS NULL AND source_kind='trusted_project'`
      )
      .run(workspaceId, projectId);
    database
      .prepare(
        `UPDATE acl_registry_migrations
         SET marker='canvas_registered',status='repair_required',failure_code='simulated_partial_write'
         WHERE workspace_id=? AND project_id=? AND canvas_id='default' AND source_kind='trusted_canvas'`
      )
      .run(workspaceId, projectId);
    database
      .prepare(
        "UPDATE canvas_registry SET package_dir_internal=NULL WHERE workspace_id=? AND project_id=? AND canvas_id='default'"
      )
      .run(workspaceId, projectId);
    database.close();

    const second = await startComposition(workspace.root, dataDirectory, projectId, false);
    const canvases = await fetch(
      `${second.origin}/api/v1/registry/projects/${projectId}/canvases`,
      {
        headers: { Authorization: `Bearer ${deviceToken}` }
      }
    );
    expect(canvases.status).toBe(200);
    await expect(canvases.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          registry: expect.objectContaining({ canvasId: "default" })
        })
      ]
    });
    await second.composition.close();
    compositions.splice(compositions.indexOf(second.composition), 1);

    const reopened = await openServerDatabase(databasePath, 5_000);
    expect(
      reopened
        .prepare(
          "SELECT status,marker,failure_code FROM acl_registry_migrations WHERE workspace_id=? AND project_id=? AND canvas_id IS NULL AND source_kind='trusted_project'"
        )
        .get(workspaceId, projectId)
    ).toEqual({ status: "completed", marker: "cutover_complete", failure_code: null });
    expect(
      reopened
        .prepare(
          "SELECT status,marker,failure_code,canvas_id FROM acl_registry_migrations WHERE workspace_id=? AND project_id=? AND canvas_id='default' AND source_kind='trusted_canvas'"
        )
        .get(workspaceId, projectId)
    ).toEqual({
      status: "completed",
      marker: "cutover_complete",
      failure_code: null,
      canvas_id: "default"
    });
    expect(
      reopened
        .prepare(
          "SELECT package_dir_internal,revoked_at FROM canvas_registry WHERE workspace_id=? AND project_id=? AND canvas_id='default'"
        )
        .get(workspaceId, projectId)
    ).toMatchObject({ package_dir_internal: defaultWorkspace.packageDir, revoked_at: null });
    expect(
      reopened
        .prepare(
          "SELECT revoked_at FROM canvas_registry WHERE workspace_id=? AND project_id=? AND canvas_id='secondary'"
        )
        .get(workspaceId, projectId)
    ).toMatchObject({ revoked_at: expect.any(String) });
    reopened.close();
    expect(await readFile(defaultWorkspace.manifestFile)).toEqual(beforeManifest);
    expect(await readFile(defaultWorkspace.stateFile)).toEqual(beforeState);
    expect(await readFile(resultPath)).toEqual(beforeResults);
  });

  it("rejects a trusted canvas path mismatch during startup repair", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    const projectId = workspace.init.workspace.id;
    const dataDirectory = join(workspace.root, "migration-conflict-data");
    const first = await startComposition(workspace.root, dataDirectory, projectId, false);
    await first.composition.close();
    compositions.splice(compositions.indexOf(first.composition), 1);
    const database = await openServerDatabase(
      join(dataDirectory, "planweave-server.sqlite"),
      5_000
    );
    const workspaceId = new WorkspaceIdentityRepository(database).workspaceForLegacyProject(
      projectId
    );
    if (!workspaceId) throw new Error("Expected workspace mapping");
    database
      .prepare(
        "UPDATE canvas_registry SET package_dir_internal=? WHERE workspace_id=? AND project_id=? AND canvas_id='default'"
      )
      .run("/tmp/not-the-runtime-package", workspaceId, projectId);
    database.close();
    await expect(startComposition(workspace.root, dataDirectory, projectId, false)).rejects.toThrow(
      "canvas_registry_conflict"
    );
  });
});
