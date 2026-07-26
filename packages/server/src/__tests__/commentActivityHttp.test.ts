import { createHash } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initWorkspace,
  writeProjectGraph,
  type InitWorkspaceResult,
  type PlanPackageManifest
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  basicManifest,
  createTestWorkspace,
  writePromptFiles
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { parseServerConfig } from "../config.js";
import { hashOperatorToken } from "../operatorAuth.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../serverComposition.js";

const servers: HttpServer[] = [];
const compositions: DistributedServerComposition[] = [];
const directories: string[] = [];
const operatorToken = "comment_http_operator_token_abcdefghijklmnopqrstuvwxyz";

afterEach(async () => {
  for (const composition of compositions.splice(0)) await composition.close();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup() {
  const manifest = basicManifest();
  const projectA = await createTestWorkspace(manifest);
  const projectBRoot = await mkdtemp(join(tmpdir(), "planweave-project-b-"));
  const projectBInit: InitWorkspaceResult = await initWorkspace({ projectRoot: projectBRoot });
  await writeFile(projectBInit.workspace.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  await writePromptFiles(projectBInit.workspace.packageDir, manifest);
  await writeProjectGraph(projectBInit.workspace, {
    version: "plan-project/v1",
    canvases: [
      {
        id: "default",
        type: "canvas",
        title: manifest.project.title,
        packageDir: "canvases/default/package",
        stateFile: "canvases/default/state.json",
        resultsDir: "canvases/default/results"
      }
    ],
    edges: [],
    crossTaskEdges: []
  });
  const projectB = { root: projectBRoot, init: projectBInit };
  directories.push(projectA.home, projectA.root, projectB.root);
  const httpServer = createServer();
  servers.push(httpServer);
  const composition = await createDistributedServerComposition({
    httpServer,
    config: parseServerConfig({
      version: "server-config/v1",
      bind: { host: "127.0.0.1", port: 7_443 },
      publicUrl: "http://127.0.0.1:7443",
      allowInsecureDevelopment: true,
      dataDirectory: join(projectA.root, "server-data"),
      trustedProjects: [
        { projectId: projectA.init.workspace.id, canvasId: "default", projectRoot: projectA.root },
        { projectId: projectB.init.workspace.id, canvasId: "default", projectRoot: projectB.root }
      ],
      operatorCredentials: [
        {
          operatorId: "admin",
          tokenSha256: hashOperatorToken(operatorToken),
          projectIds: [],
          serverAdmin: true
        }
      ]
    })
  });
  compositions.push(composition);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    projectA,
    projectB,
    manifest
  };
}

function jsonHeaders(token?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

async function bootstrap(origin: string, projectId: string, principalId: string): Promise<string> {
  const response = await fetch(`${origin}/api/v1/projects/${projectId}/human/bootstrap`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ displayName: principalId, humanPrincipalId: principalId })
  });
  const payload = (await response.json()) as { deviceToken?: string };
  expect(response.status).toBe(201);
  if (!payload.deviceToken) throw new Error("Expected bootstrap device token");
  return payload.deviceToken;
}

describe("comment and activity production HTTP", () => {
  it("wires create/list/edit/tombstone/activity with project, CAS, package, and attachment bounds", async () => {
    const fixture = await setup();
    const projectId = fixture.projectA.init.workspace.id;
    const otherProjectId = fixture.projectB.init.workspace.id;
    const token = await bootstrap(fixture.origin, projectId, "comment-owner-a");
    const otherToken = await bootstrap(fixture.origin, otherProjectId, "comment-owner-b");
    const workItem = { kind: "block", canvasId: "default", blockRef: "T-001#B-001" };

    const bytes = Buffer.from("comment attachment");
    const digestSha256 = createHash("sha256").update(bytes).digest("hex");
    const staged = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/attachments/pending`,
      {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify({
          expectedSizeBytes: bytes.byteLength,
          mediaType: "text/plain",
          expectedDigestSha256: digestSha256,
          fileName: "evidence.txt"
        })
      }
    );
    const stagedBody = (await staged.json()) as { pendingUploadId: string };
    expect(staged.status).toBe(201);
    const uploaded = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/attachments/pending/${stagedBody.pendingUploadId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "text/plain",
          "content-length": String(bytes.byteLength),
          "x-planweave-content-sha256": digestSha256
        },
        body: bytes
      }
    );
    expect(uploaded.status).toBe(201);

    const create = await fetch(`${fixture.origin}/api/v1/projects/${projectId}/comments`, {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({
        workItem,
        body: "Initial comment",
        attachments: [
          {
            pendingUploadId: stagedBody.pendingUploadId,
            digestSha256,
            sizeBytes: bytes.byteLength,
            mediaType: "text/plain",
            fileName: "evidence.txt"
          }
        ]
      })
    });
    const created = (await create.json()) as {
      commentId: string;
      revision: number;
      body: string | null;
      attachments: Array<{ digestSha256: string }>;
    };
    expect(create.status).toBe(201);
    expect(created).toMatchObject({ revision: 1, body: "Initial comment" });
    expect(created.attachments).toEqual([expect.objectContaining({ digestSha256 })]);

    const attachment = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/attachments/comments/${created.commentId}/${digestSha256}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(attachment.status).toBe(200);
    expect(Buffer.from(await attachment.arrayBuffer())).toEqual(bytes);

    const edit = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/comments/${created.commentId}`,
      {
        method: "PATCH",
        headers: jsonHeaders(token),
        body: JSON.stringify({ body: "Edited comment", expectedRevision: 1 })
      }
    );
    expect(edit.status).toBe(200);
    await expect(edit.json()).resolves.toMatchObject({ body: "Edited comment", revision: 2 });

    const staleEdit = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/comments/${created.commentId}`,
      {
        method: "PATCH",
        headers: jsonHeaders(token),
        body: JSON.stringify({ body: "Stale edit", expectedRevision: 1 })
      }
    );
    expect(staleEdit.status).toBe(409);
    await expect(staleEdit.json()).resolves.toEqual({ error: "comment_revision_conflict" });

    const missingManifest: PlanPackageManifest = { ...fixture.manifest, nodes: [], edges: [] };
    await writeFile(
      fixture.projectA.init.workspace.manifestFile,
      `${JSON.stringify(missingManifest, null, 2)}\n`,
      "utf8"
    );
    const listParams = new URLSearchParams({
      workItem: JSON.stringify(workItem),
      limit: "20",
      includeTombstoned: "false"
    });
    const list = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/comments?${listParams}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      items: [{ commentId: created.commentId, workItemPresence: "missing", body: "Edited comment" }]
    });

    const tombstone = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/comments/${created.commentId}/tombstone`,
      {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify({ expectedRevision: 2, reason: "Cleanup" })
      }
    );
    expect(tombstone.status).toBe(200);
    await expect(tombstone.json()).resolves.toMatchObject({
      commentId: created.commentId,
      revision: 3,
      tombstoned: true,
      body: null
    });

    const activity = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/activity?limit=20`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(activity.status).toBe(200);
    const activityBody = (await activity.json()) as { items: Array<{ type: string }> };
    expect(activityBody.items.map((item) => item.type)).toEqual([
      "comment_tombstoned",
      "comment_edited",
      "comment_created"
    ]);

    const crossProject = await fetch(
      `${fixture.origin}/api/v1/projects/${projectId}/activity?limit=20`,
      { headers: { Authorization: `Bearer ${otherToken}` } }
    );
    expect(crossProject.status).toBe(401);

    const unknown = await fetch(
      `${fixture.origin}/api/v1/projects/unknown-project/comments?${listParams}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    expect(unknown.status).toBe(403);
    await expect(unknown.json()).resolves.toEqual({ error: "comment_cross_project_forbidden" });

    for (const invalidToken of ["pw_host_not_human", operatorToken]) {
      const denied = await fetch(
        `${fixture.origin}/api/v1/projects/${projectId}/activity?limit=20`,
        { headers: { Authorization: `Bearer ${invalidToken}` } }
      );
      expect(denied.status).toBe(401);
    }
  });
});
