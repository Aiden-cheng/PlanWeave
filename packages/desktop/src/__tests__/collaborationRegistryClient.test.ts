import { describe, expect, it, vi } from "vitest";
import { CollaborationClient } from "../main/collaboration/CollaborationClient.js";
import {
  CollaborationRegistryClient,
  type RegistryJsonRequest
} from "../main/collaboration/CollaborationRegistryClient.js";
import { CollaborationRegistryService } from "../main/collaboration/CollaborationRegistryService.js";

const page = { items: [], nextCursor: null };

describe("CollaborationRegistryClient", () => {
  it("builds bounded registry paths without exposing filesystem fields", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const request: RegistryJsonRequest = async (method, path, schema) => {
      calls.push({ method, path });
      return schema.parse(page);
    };
    const client = new CollaborationRegistryClient(request);

    await client.listProjects({ cursor: 2, limit: 3 });
    await client.listCanvases({ projectId: "project-a", cursor: 0, limit: 1 });

    expect(calls).toEqual([
      { method: "GET", path: "/api/v1/registry/projects?cursor=2&limit=3" },
      {
        method: "GET",
        path: "/api/v1/registry/projects/project-a/canvases?cursor=0&limit=1"
      }
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/projectRoot|packageDir|\/srv/);
  });

  it("rejects malformed bounded commands before transport", async () => {
    const request = vi.fn<RegistryJsonRequest>(async (_method, _path, schema) =>
      schema.parse(page)
    );
    const client = new CollaborationRegistryClient(request);

    await expect(client.listProjects({ limit: 101 })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("accepts only restore conflict status for the typed result", async () => {
    const conflict = {
      schemaVersion: "package-snapshot/v1",
      outcome: "conflict",
      snapshotId: "snapshot-001",
      scope: { workspaceId: "workspace-a", projectId: "project-a", canvasId: "default" },
      actor: { kind: "human", id: "human-owner", displayName: "Owner" },
      aclRevision: 1,
      migrationMarker: "none",
      sourceRevision: null,
      restoredAt: null,
      detail: "stale_acl_revision"
    };
    const request: RegistryJsonRequest = async (_method, _path, schema) => schema.parse(conflict);
    const client = new CollaborationRegistryClient(request);
    await expect(
      client.restoreSnapshot({
        projectId: "project-a",
        canvasId: "default",
        snapshotId: "snapshot-001",
        expectedAclRevision: 0
      })
    ).resolves.toMatchObject({ outcome: "conflict" });
  });
});

describe("CollaborationRegistryService", () => {
  it("parses operation commands and requires an active session", async () => {
    const request: typeof fetch = async () =>
      new Response(JSON.stringify(page), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    const client = new CollaborationClient({
      profile: {
        profileId: "profile-a",
        displayName: "Profile A",
        serverBaseUrl: "https://collaboration.example",
        projectId: "project-a",
        allowInsecureTransport: false
      },
      credential: { getDeviceToken: () => "pw_hdev_test" },
      request
    });
    const service = new CollaborationRegistryService(() => client);

    await expect(service.listAuthorizedProjects({ limit: 101 })).rejects.toThrow();
    await expect(service.listAuthorizedProjects({ limit: 1 })).resolves.toEqual(page);
    client.dispose();

    const offline = new CollaborationRegistryService(() => null);
    await expect(offline.listAuthorizedProjects()).rejects.toMatchObject({
      code: "collaboration_session_inactive"
    });
  });

  it("accepts restore HTTP 409 conflicts but keeps other HTTP 409 failures", async () => {
    const conflict = {
      schemaVersion: "package-snapshot/v1",
      outcome: "conflict",
      snapshotId: "snapshot-001",
      scope: { workspaceId: "workspace-a", projectId: "project-a", canvasId: "default" },
      actor: { kind: "human", id: "human-owner", displayName: "Owner" },
      aclRevision: 1,
      migrationMarker: "none",
      sourceRevision: null,
      restoredAt: null,
      detail: "stale_acl_revision"
    };
    const request: typeof fetch = async () =>
      new Response(JSON.stringify(conflict), {
        status: 409,
        headers: { "content-type": "application/json" }
      });
    const client = new CollaborationClient({
      profile: {
        profileId: "profile-a",
        displayName: "Profile A",
        serverBaseUrl: "https://collaboration.example",
        projectId: "project-a",
        allowInsecureTransport: false
      },
      credential: { getDeviceToken: () => "pw_hdev_test" },
      request
    });

    await expect(
      client.registry().restoreSnapshot({
        projectId: "project-a",
        canvasId: "default",
        snapshotId: "snapshot-001",
        expectedAclRevision: 0
      })
    ).resolves.toMatchObject({ outcome: "conflict" });
    await expect(client.registry().listProjects()).rejects.toThrow();
    client.dispose();
  });
});
