import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseServerConfig } from "@planweave-ai/server";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeploymentActions,
  DeploymentBundleUnavailableError
} from "../main/collaboration/deploymentActions.js";

const target = {
  schemaVersion: "deployment-target-draft/v1" as const,
  displayName: "Self-hosted Server",
  endpoint: {
    topology: "public_https" as const,
    serverOrigin: "https://collab.example.test/",
    allowedClientOrigins: ["https://collab.example.test/"],
    tlsTrust: "system_ca" as const
  },
  capabilities: ["deployment_guidance", "connectivity_validation"]
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function request(
  action:
    | "request_deployment_guidance"
    | "copy_supported_compose_handoff"
    | "export_supported_compose_bundle"
    | "validate_connectivity"
) {
  return { action, target };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "planweave-deployment-actions-"));
  roots.push(root);
  return root;
}

describe("DeploymentActions", () => {
  it("generates and copies only the fixed supported Compose handoff", () => {
    const copied: string[] = [];
    const actions = new DeploymentActions({
      writeClipboard: (value) => copied.push(value),
      now: () => new Date("2030-01-01T00:00:00.000Z")
    });
    const guidance = actions.guidance(request("request_deployment_guidance"));
    expect(guidance.handoff.preview).toContain("--detach --wait");
    expect(guidance.handoff.projectsMountTarget).toBe("/var/lib/planweave/projects");
    expect(actions.copyComposeHandoff(request("copy_supported_compose_handoff"))).toEqual({
      state: "copied",
      copiedAt: "2030-01-01T00:00:00.000Z"
    });
    expect(copied).toEqual([guidance.handoff.preview]);
  });

  it("keeps loopback out of direct-TLS handoff without rejecting generic private HTTPS", () => {
    const actions = new DeploymentActions();
    const loopback = {
      ...target,
      endpoint: {
        topology: "loopback_http" as const,
        serverOrigin: "http://127.0.0.1:7443/",
        allowedClientOrigins: ["http://127.0.0.1:7443/"],
        tlsTrust: "not_applicable" as const
      }
    };
    expect(
      actions.guidance({
        action: "request_deployment_guidance",
        target: loopback
      }).handoff.state
    ).toBe("not_applicable");
    expect(() =>
      actions.copyComposeHandoff({
        action: "copy_supported_compose_handoff",
        target: loopback
      })
    ).toThrow("deployment_compose_handoff_not_supported");
    const privateHttps = {
      ...target,
      endpoint: {
        topology: "private_https" as const,
        serverOrigin: "https://planweave.tailnet.ts.net/",
        allowedClientOrigins: ["https://planweave.tailnet.ts.net/"],
        tlsTrust: "system_ca" as const
      }
    };
    expect(
      actions.guidance({
        action: "request_deployment_guidance",
        target: privateHttps
      }).handoff.state
    ).toBe("supported");
  });

  it("reports static origin configuration failures without claiming a WebSocket probe", async () => {
    const actions = new DeploymentActions({
      request: async () => new Response(null, { status: 200 })
    });
    const mismatched = {
      ...target,
      endpoint: { ...target.endpoint, allowedClientOrigins: ["https://desktop.example.test/"] }
    };
    await expect(
      actions.validateConnectivity({
        action: "validate_connectivity",
        target: mismatched
      })
    ).resolves.toMatchObject({
      status: "invalid_origin",
      failureCode: "allowed_client_origin_missing"
    });
  });

  it("does not provision a deployment source when export is cancelled", async () => {
    const resolveBundleSource = vi.fn();
    const actions = new DeploymentActions({
      resourceDirectory: "/unused",
      resolveBundleSource,
      showSaveDialog: async () => ({ canceled: true })
    });
    await expect(
      actions.exportComposeBundle(request("export_supported_compose_bundle"))
    ).resolves.toMatchObject({
      state: "cancelled"
    });
    expect(resolveBundleSource).not.toHaveBeenCalled();
  });

  it("returns only explicit deployment unavailability and surfaces credential failures", async () => {
    const unavailable = new DeploymentActions({
      resourceDirectory: "/unused",
      resolveBundleSource: async () => {
        throw new DeploymentBundleUnavailableError("needs_project", "selection_missing");
      },
      showSaveDialog: async () => ({ canceled: false, filePath: "/tmp/bundle.zip" })
    });
    await expect(
      unavailable.exportComposeBundle(request("export_supported_compose_bundle"))
    ).resolves.toMatchObject({
      state: "needs_project"
    });

    const failing = new DeploymentActions({
      resourceDirectory: "/unused",
      resolveBundleSource: async () => {
        throw new Error("secure_storage_failed");
      },
      showSaveDialog: async () => ({ canceled: false, filePath: "/tmp/bundle.zip" })
    });
    await expect(
      failing.exportComposeBundle(request("export_supported_compose_bundle"))
    ).rejects.toThrow("secure_storage_failed");
  });

  it("exports a portable non-symlink source bundle", async () => {
    const root = await temporaryRoot();
    const resourceDirectory = join(root, "resource");
    const workspaceRoot = join(root, "workspace");
    const bundlePath = join(root, "bundle.zip");
    await Promise.all([
      mkdir(join(resourceDirectory, "image"), { recursive: true }),
      mkdir(workspaceRoot, { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(resourceDirectory, "compose.yaml"), "services: {}\n"),
      writeFile(join(resourceDirectory, "image", "Dockerfile"), "FROM scratch\n"),
      writeFile(
        join(workspaceRoot, "project.json"),
        JSON.stringify({
          id: "project-test",
          name: "Source project",
          rootPath: workspaceRoot,
          kind: "external",
          sourceRoot: workspaceRoot,
          createdAt: "2030-01-01T00:00:00.000Z"
        })
      ),
      writeFile(join(workspaceRoot, "project.txt"), "portable workspace\n")
    ]);
    const source = {
      config: parseServerConfig({
        version: "server-config/v1",
        bind: { host: "0.0.0.0", port: 443 },
        publicUrl: target.endpoint.serverOrigin,
        deployment: target.endpoint,
        tls: {
          certificatePath: "/run/planweave/input/tls/server.crt",
          privateKeyPath: "/run/planweave/input/tls/server.key"
        },
        dataDirectory: "/var/lib/planweave-server",
        trustedProjects: [
          {
            workspaceId: "workspace-test",
            projectId: "project-test",
            canvasId: "default",
            projectRoot: "/var/lib/planweave/projects/project-test"
          }
        ],
        operatorCredentials: [
          {
            operatorId: "operator-test",
            tokenSha256: "a".repeat(64),
            projectIds: [],
            serverAdmin: true
          }
        ]
      }),
      workspaceRoot,
      projectId: "project-test"
    };
    const actions = new DeploymentActions({
      resourceDirectory,
      resolveBundleSource: async () => source,
      showSaveDialog: async () => ({ canceled: false, filePath: bundlePath })
    });
    await expect(
      actions.exportComposeBundle(request("export_supported_compose_bundle"))
    ).resolves.toEqual({
      state: "exported",
      fileName: "bundle.zip",
      tls: "required_after_export"
    });
    const archive = unzipSync(await readFile(bundlePath));
    expect(Object.keys(archive)).toEqual(
      expect.arrayContaining([
        "compose.yaml",
        "image/Dockerfile",
        "projects/project-test/project.json",
        "projects/project-test/project.txt"
      ])
    );
    expect(
      JSON.parse(new TextDecoder().decode(archive["projects/project-test/project.json"]))
    ).toMatchObject({
      id: "project-test",
      kind: "managed",
      rootPath: "/var/lib/planweave/projects/project-test",
      sourceRoot: null
    });
  });
});
