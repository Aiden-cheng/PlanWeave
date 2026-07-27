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
import { hashOperatorToken } from "../operatorAuth.js";
import { parseServerConfig } from "../config.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import {
  aclMigrationIdFor,
  applyMigrations,
  latestCentralSchemaVersion,
  projectRegistryIdFor
} from "../migrations.js";
import { openServerDatabase } from "../sqlite.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../serverComposition.js";

const httpServers: HttpServer[] = [];
const compositions: DistributedServerComposition[] = [];
const directories: string[] = [];
const adminToken = `pw_operator_${"A".repeat(43)}`;
const projectToken = `pw_operator_${"B".repeat(43)}`;

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

async function setup() {
  const workspace = await createTestWorkspace(remoteManifest());
  directories.push(workspace.home, workspace.root);
  const httpServer = createServer();
  httpServers.push(httpServer);
  const dataDirectory = join(workspace.root, "server-data");
  const projectId = workspace.init.workspace.id;
  const config = parseServerConfig({
    version: "server-config/v1",
    bind: { host: "127.0.0.1", port: 7_443 },
    publicUrl: "http://127.0.0.1:7443",
    allowInsecureDevelopment: true,
    dataDirectory,
    trustedProjects: [{ projectId, canvasId: "default", projectRoot: workspace.root }],
    operatorCredentials: [
      {
        operatorId: "admin",
        tokenSha256: hashOperatorToken(adminToken),
        projectIds: [],
        serverAdmin: true
      },
      {
        operatorId: "project-operator",
        tokenSha256: hashOperatorToken(projectToken),
        projectIds: [projectId]
      }
    ]
  });
  const composition = await createDistributedServerComposition({
    httpServer,
    config
  });
  compositions.push(composition);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP address");
  return { composition, projectId, origin: `http://127.0.0.1:${address.port}` };
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
  await mkdir(join(loaded.workspace.workspaceRoot, "canvases", "undeclared"), {
    recursive: true
  });
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

function jsonHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

describe("distributed server composition", () => {
  it("materializes trusted registry owners during bootstrap for listing and management", async () => {
    const fixture = await setup();
    const bootstrap = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/human/bootstrap`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Trusted Owner", humanPrincipalId: "trusted-owner" })
      }
    );
    expect(bootstrap.status).toBe(201);
    const bootstrapBody = (await bootstrap.json()) as { deviceToken: string };
    const headers = { Authorization: `Bearer ${bootstrapBody.deviceToken}` };

    const projects = await fetch(`${fixture.origin}/api/v1/registry/projects`, { headers });
    expect(projects.status).toBe(200);
    await expect(projects.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          registry: expect.objectContaining({ projectId: fixture.projectId }),
          owner: "trusted-owner"
        })
      ]
    });

    const canvases = await fetch(
      `${fixture.origin}/api/v1/registry/projects/${fixture.projectId}/canvases`,
      { headers }
    );
    expect(canvases.status).toBe(200);
    const canvasesBody = (await canvases.json()) as {
      items: Array<{ registry: { canvasId: string }; owner: string; acl: { revision: number } }>;
    };
    expect(canvasesBody.items).toEqual([
      expect.objectContaining({
        registry: expect.objectContaining({ canvasId: "default" }),
        owner: "trusted-owner",
        acl: { revision: 0, updatedAt: expect.any(String) }
      })
    ]);

    const snapshot = await fetch(
      `${fixture.origin}/api/v1/registry/projects/${fixture.projectId}/canvases/default/snapshots`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          projectId: fixture.projectId,
          canvasId: "default",
          expectedAclRevision: canvasesBody.items[0].acl.revision
        })
      }
    );
    expect(snapshot.status).toBe(201);
  });

  it("registers every Runtime canvas from one trusted entry and ignores undeclared paths", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    await addSecondaryCanvas(workspace.root);
    const dataDirectory = join(workspace.root, "multi-canvas-server-data");
    const httpServer = createServer();
    httpServers.push(httpServer);
    const projectId = workspace.init.workspace.id;
    const config = parseServerConfig({
      version: "server-config/v1",
      bind: { host: "127.0.0.1", port: 7_443 },
      publicUrl: "http://127.0.0.1:7443",
      allowInsecureDevelopment: true,
      dataDirectory,
      trustedProjects: [{ projectId, projectRoot: workspace.root, trustAllDeclaredCanvases: true }],
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
    const origin = `http://127.0.0.1:${address.port}`;
    const bootstrap = await fetch(`${origin}/api/v1/projects/${projectId}/human/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Trusted Owner", humanPrincipalId: "trusted-owner" })
    });
    expect(bootstrap.status).toBe(201);
    const { deviceToken } = (await bootstrap.json()) as { deviceToken: string };
    const canvases = await fetch(`${origin}/api/v1/registry/projects/${projectId}/canvases`, {
      headers: { Authorization: `Bearer ${deviceToken}` }
    });
    expect(canvases.status).toBe(200);
    await expect(canvases.json()).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          registry: expect.objectContaining({ canvasId: "default" })
        }),
        expect.objectContaining({
          registry: expect.objectContaining({ canvasId: "secondary" })
        })
      ])
    });
    const secondaryDispatch = await fetch(`${origin}/api/v1/remote-operations`, {
      method: "POST",
      headers: jsonHeaders(adminToken),
      body: JSON.stringify({
        projectId,
        canvasId: "secondary",
        blockRef: "T-001#B-001",
        idempotencyKey: "secondary-dispatch"
      })
    });
    expect(secondaryDispatch.status).toBe(202);
  });

  it("does not expose secondary canvases through legacy canvas trust", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    await addSecondaryCanvas(workspace.root);
    const dataDirectory = join(workspace.root, "legacy-canvas-scope-server-data");
    const httpServer = createServer();
    httpServers.push(httpServer);
    const projectId = workspace.init.workspace.id;
    const config = parseServerConfig({
      version: "server-config/v1",
      bind: { host: "127.0.0.1", port: 7_443 },
      publicUrl: "http://127.0.0.1:7443",
      allowInsecureDevelopment: true,
      dataDirectory,
      trustedProjects: [{ projectId, projectRoot: workspace.root, canvasId: "default" }],
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
    const origin = `http://127.0.0.1:${address.port}`;
    const bootstrap = await fetch(`${origin}/api/v1/projects/${projectId}/human/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Trusted Owner", humanPrincipalId: "trusted-owner" })
    });
    expect(bootstrap.status).toBe(201);
    const { deviceToken } = (await bootstrap.json()) as { deviceToken: string };
    const canvases = await fetch(`${origin}/api/v1/registry/projects/${projectId}/canvases`, {
      headers: { Authorization: `Bearer ${deviceToken}` }
    });
    expect(canvases.status).toBe(200);
    await expect(canvases.json()).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          registry: expect.objectContaining({ canvasId: "default" })
        })
      ]
    });
    const secondaryDispatch = await fetch(`${origin}/api/v1/remote-operations`, {
      method: "POST",
      headers: jsonHeaders(adminToken),
      body: JSON.stringify({
        projectId,
        canvasId: "secondary",
        blockRef: "T-001#B-001",
        idempotencyKey: "legacy-secondary-dispatch"
      })
    });
    expect(secondaryDispatch.status).not.toBe(202);
  });

  it("wires health, enrollment, scoped dispatch, idempotency, pagination, and shutdown", async () => {
    const fixture = await setup();
    expect(fixture.composition.ownsHttpServer).toBe(false);
    await expect((await fetch(`${fixture.origin}/readyz`)).json()).resolves.toEqual({
      status: "ready",
      schemaVersion: latestCentralSchemaVersion
    });

    const trustedBootstrap = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/human/bootstrap`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Trusted Owner", humanPrincipalId: "trusted-owner" })
      }
    );
    expect(trustedBootstrap.status).toBe(201);

    const unknownBootstrap = await fetch(
      `${fixture.origin}/api/v1/projects/unknown-project/human/bootstrap`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Unknown Owner", humanPrincipalId: "unknown-owner" })
      }
    );
    expect(unknownBootstrap.status).toBe(403);
    await expect(unknownBootstrap.json()).resolves.toEqual({
      error: "human_cross_project_forbidden"
    });

    const enrollment = await fetch(`${fixture.origin}/api/v1/host-enrollments`, {
      method: "POST",
      headers: jsonHeaders(adminToken),
      body: JSON.stringify({
        expiresAt: "2030-01-01T00:00:00.000Z",
        credentialExpiresAt: "2030-01-02T00:00:00.000Z"
      })
    });
    expect(enrollment.status).toBe(201);
    await expect(enrollment.json()).resolves.toMatchObject({
      enrollmentCode: expect.stringMatching(/^pw_enroll_/)
    });

    const request = {
      projectId: fixture.projectId,
      canvasId: "default",
      blockRef: "T-001#B-001",
      idempotencyKey: "composition-dispatch-1"
    };
    const dispatch = async (token: string, body = request) =>
      fetch(`${fixture.origin}/api/v1/remote-operations`, {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify(body)
      });
    const first = await dispatch(adminToken);
    const second = await dispatch(adminToken);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(secondBody.operationId).toBe(firstBody.operationId);

    const forbidden = await dispatch(projectToken, { ...request, projectId: "different-project" });
    expect(forbidden.status).toBe(403);
    const hosts = await fetch(`${fixture.origin}/api/v1/hosts?limit=1`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    expect(hosts.status).toBe(200);
    await expect(hosts.json()).resolves.toEqual({ items: [], nextCursor: null });

    await fixture.composition.close();
    await fixture.composition.close();
    expect(fixture.composition.readiness()).toMatchObject({ status: "draining" });
    compositions.splice(compositions.indexOf(fixture.composition), 1);
  });

  it("binds an unbound legacy registry row without rewriting package/state/results", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    const dataDirectory = join(workspace.root, "legacy-server-data");
    const databasePath = join(dataDirectory, "planweave-server.sqlite");
    const database = await openServerDatabase(databasePath, 5_000);
    applyMigrations(database);
    const workspaceIdentity = new WorkspaceIdentityRepository(database);
    const workspaceId = workspaceIdentity.ensureWorkspaceForLegacyProject(
      workspace.init.workspace.id
    );
    const at = "2026-01-01T00:00:00.000Z";
    database
      .prepare(
        `INSERT INTO project_registry(project_registry_id,workspace_id,project_id,project_root_internal,visibility,owner_human_principal_id,acl_revision,created_at,updated_at,revoked_at) VALUES(?,?,?,NULL,'private',NULL,0,?,?,NULL)`
      )
      .run(
        projectRegistryIdFor(workspaceId, workspace.init.workspace.id),
        workspaceId,
        workspace.init.workspace.id,
        at,
        at
      );
    database
      .prepare(
        `INSERT INTO acl_registry_migrations(migration_id,workspace_id,project_id,canvas_id,source_kind,marker,status,failure_code,updated_at) VALUES(?,?,?,NULL,'legacy_project','project_registered','pending',NULL,?)`
      )
      .run(
        aclMigrationIdFor("legacy_project", workspaceId, workspace.init.workspace.id),
        workspaceId,
        workspace.init.workspace.id,
        at
      );
    const beforeManifest = await readFile(workspace.init.workspace.manifestFile);
    const beforeState = await readFile(workspace.init.workspace.stateFile);
    const resultsFile = join(workspace.init.workspace.resultsDir, "existing-result.json");
    await writeFile(resultsFile, '{"result":"preserve"}\n', "utf8");
    const beforeResults = await readFile(resultsFile);
    database.close();
    const httpServer = createServer();
    httpServers.push(httpServer);
    const config = parseServerConfig({
      version: "server-config/v1",
      bind: { host: "127.0.0.1", port: 7_443 },
      publicUrl: "http://127.0.0.1:7443",
      allowInsecureDevelopment: true,
      dataDirectory,
      trustedProjects: [
        { projectId: workspace.init.workspace.id, canvasId: "default", projectRoot: workspace.root }
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
    const reopened = await openServerDatabase(databasePath, 5_000);
    expect(
      reopened
        .prepare("SELECT project_root_internal FROM project_registry WHERE project_id=?")
        .get(workspace.init.workspace.id)?.project_root_internal
    ).toBe(workspace.root);
    expect(
      reopened
        .prepare(
          "SELECT status,marker FROM acl_registry_migrations WHERE workspace_id=? AND project_id=? AND source_kind='legacy_project'"
        )
        .get(workspaceId, workspace.init.workspace.id)
    ).toEqual({ status: "completed", marker: "cutover_complete" });
    expect(await readFile(workspace.init.workspace.manifestFile)).toEqual(beforeManifest);
    expect(await readFile(workspace.init.workspace.stateFile)).toEqual(beforeState);
    expect(await readFile(resultsFile)).toEqual(beforeResults);
    reopened.close();
  });

  it("revokes Runtime canvases removed between composition startups", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    await addSecondaryCanvas(workspace.root);
    const projectId = workspace.init.workspace.id;
    const dataDirectory = join(workspace.root, "reconcile-server-data");
    const loaded = await loadProjectGraph(workspace.root);
    const secondaryCanvas = loaded.manifest.canvases.find((canvas) => canvas.id === "secondary");
    if (!secondaryCanvas) throw new Error("Expected secondary canvas");
    const secondaryWorkspace = projectCanvasWorkspace(loaded.workspace, secondaryCanvas);
    const secondaryManifestBefore = await readFile(secondaryWorkspace.manifestFile);
    const secondaryResultPath = join(secondaryWorkspace.resultsDir, "existing-result.json");
    await mkdir(secondaryWorkspace.resultsDir, { recursive: true });
    await writeFile(secondaryResultPath, '{"result":"preserve"}\n', "utf8");
    const secondaryResultsBefore = await readFile(secondaryResultPath);

    const startComposition = async () => {
      const httpServer = createServer();
      httpServers.push(httpServer);
      const config = parseServerConfig({
        version: "server-config/v1",
        bind: { host: "127.0.0.1", port: 7_443 },
        publicUrl: "http://127.0.0.1:7443",
        allowInsecureDevelopment: true,
        dataDirectory,
        trustedProjects: [
          { projectId, projectRoot: workspace.root, trustAllDeclaredCanvases: true }
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
      return composition;
    };

    const first = await startComposition();
    await first.close();
    compositions.splice(compositions.indexOf(first), 1);
    const current = await loadProjectGraph(workspace.root);
    const defaultCanvas = current.manifest.canvases.find((canvas) => canvas.id === "default");
    if (!defaultCanvas) throw new Error("Expected default canvas");
    await writeProjectGraph(current.workspace, {
      version: "plan-project/v1",
      canvases: [defaultCanvas],
      edges: [],
      crossTaskEdges: []
    });

    const second = await startComposition();
    await second.close();
    compositions.splice(compositions.indexOf(second), 1);
    const database = await openServerDatabase(
      join(dataDirectory, "planweave-server.sqlite"),
      5_000
    );
    const workspaceId = new WorkspaceIdentityRepository(database).workspaceForLegacyProject(
      projectId
    );
    if (!workspaceId) throw new Error("Expected workspace mapping");
    expect(
      database
        .prepare(
          "SELECT revoked_at FROM canvas_registry WHERE workspace_id=? AND project_id=? AND canvas_id=?"
        )
        .get(workspaceId, projectId, "default")
    ).toMatchObject({ revoked_at: null });
    expect(
      database
        .prepare(
          "SELECT revoked_at FROM canvas_registry WHERE workspace_id=? AND project_id=? AND canvas_id=?"
        )
        .get(workspaceId, projectId, "secondary")
    ).toMatchObject({ revoked_at: expect.any(String) });
    const access = new ProjectAccessRepository(database);
    expect(() =>
      access.registry.resolveCanvasPath({
        workspaceId,
        projectId,
        canvasId: "secondary"
      })
    ).toThrow("runtime_canvas_revoked");
    database.close();
    expect(await readFile(secondaryWorkspace.manifestFile)).toEqual(secondaryManifestBefore);
    expect(await readFile(secondaryResultPath)).toEqual(secondaryResultsBefore);
  });
});
