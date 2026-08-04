import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentHostSetupHandoffSchema,
  serializeAgentHostSetupHandoff
} from "@planweave-ai/agent-host-protocol";
import {
  configFromAgentHostSetupHandoff,
  resolveAgentHostDefaultPaths
} from "../config/defaultPaths.js";
import { FileHostCredentialStore } from "../credentials/fileCredentialStore.js";
import {
  createPendingPortableHandoffProvenance,
  verifyActivePortableHandoffProvenance
} from "../credentials/handoffProvenance.js";
import { AgentHostEnrollmentService } from "../enrollment/enrollmentService.js";
import { AgentHostOperator, loadAgentHostConfig } from "../operator/agentHostOperator.js";
import { parseAgentHostArgs, runAgentHostCli } from "../operator/cli.js";
import { AgentHostBackgroundSetupError } from "../background/backgroundService.js";

const mockedHome = vi.hoisted(() => ({ path: "" }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => mockedHome.path
}));

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

function encodedHandoff(
  input: { workspaceId?: string; enrollmentCode?: string; serverOrigin?: string } = {}
) {
  const serverOrigin = input.serverOrigin ?? "http://192.168.1.8:4317";
  return serializeAgentHostSetupHandoff(
    agentHostSetupHandoffSchema.parse({
      version: "agent-host-setup/v1",
      endpoint: {
        topology: serverOrigin.includes("127.0.0.1") ? "loopback_http" : "lan_http",
        serverOrigin,
        allowedClientOrigins: [serverOrigin],
        tlsTrust: "not_applicable"
      },
      workspaceId: input.workspaceId ?? "workspace-1",
      enrollmentCode: input.enrollmentCode ?? `pw_enroll_${"a".repeat(43)}`,
      expiresAt: "2030-01-01T00:00:00.000Z",
      display: { workspaceName: "Studio", serverName: "Private server" }
    })
  );
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected_port");
  return address.port;
}

describe("portable Agent Host setup", () => {
  it("derives private per-workspace paths and a config without the one-time code", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-portable-host-"));
    directories.push(home);
    const handoff = encodedHandoff();
    const paths = resolveAgentHostDefaultPaths("workspace-1", home);
    const config = configFromAgentHostSetupHandoff(
      (await import("@planweave-ai/agent-host-protocol")).parseAgentHostSetupHandoff(
        handoff,
        new Date("2029-01-01")
      ),
      { paths, hostDisplayName: "Build host" }
    );
    expect(config.coordinator.endpoint?.topology).toBe("lan_http");
    expect(config.agentProfiles).toEqual([]);
    expect(paths.configPath).toContain(join("instances", "workspace-1"));
    expect(JSON.stringify(config)).not.toContain("pw_enroll_");
  });

  it("parses the single-command handoff and exposure commands", () => {
    expect(parseAgentHostArgs(["enroll", encodedHandoff(), "--no-background"])).toMatchObject({
      command: "enroll",
      handoff: encodedHandoff(),
      installBackground: false
    });
    expect(parseAgentHostArgs(["agents", "expose", "codex-acp", "--config", "/cfg"])).toEqual({
      command: "agents-expose",
      configPath: "/cfg",
      profileId: "codex-acp",
      replace: false
    });
  });

  it("does not echo a handoff when enrollment fails", async () => {
    const stderr = vi.fn();
    const handoff = encodedHandoff();
    await expect(
      runAgentHostCli(["enroll", handoff], {
        operator: {
          enrollHandoff: vi.fn().mockRejectedValue(new Error("private handoff payload"))
        } as never,
        io: { stdout: vi.fn(), stderr }
      })
    ).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith("agent_host_failed");
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(handoff);
  });

  it("passes the real npm Node launcher shape and prints structured next steps", async () => {
    const stdout = vi.fn();
    const enrollHandoff = vi.fn().mockResolvedValue({
      state: "ready",
      workspaceId: "workspace-1",
      credential: "active",
      background: "running",
      configPath: "/Users/operator/PlanWeave Host/config.json",
      agents: [],
      nextSteps: {
        listAgents: {
          command: "planweave-agent-host",
          args: ["agents", "list", "--config", "/Users/operator/PlanWeave Host/config.json"]
        }
      }
    });
    await expect(
      runAgentHostCli(["enroll", encodedHandoff()], {
        operator: { enrollHandoff } as never,
        launcher: {
          executablePath: "/Applications/Node Runtime/bin/node",
          fixedArgs: ["/opt/npm packages/@planweave-ai/agent-host/dist/bin.js"]
        },
        io: { stdout, stderr: vi.fn() }
      })
    ).resolves.toBe(0);
    expect(enrollHandoff).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        executablePath: "/Applications/Node Runtime/bin/node",
        fixedArgs: ["/opt/npm packages/@planweave-ai/agent-host/dist/bin.js"]
      })
    );
    expect(JSON.parse(stdout.mock.calls[0]?.[0] as string)).toMatchObject({
      configPath: "/Users/operator/PlanWeave Host/config.json",
      nextSteps: {
        listAgents: {
          args: ["agents", "list", "--config", "/Users/operator/PlanWeave Host/config.json"]
        }
      }
    });
  });

  it("persists portable pending on interruption and promotes the same provenance on resume", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-portable-operator-"));
    directories.push(home);
    mockedHome.path = home;
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        if (requests === 1) {
          request.socket.destroy();
          return;
        }
        const parsed = JSON.parse(body) as {
          enrollmentAttemptId: string;
        };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            type: "host.enrollment.completed",
            protocolVersion: 1,
            enrollmentAttemptId: parsed.enrollmentAttemptId,
            hostId: "host-portable-operator",
            workspaceId: "workspace-portable-operator",
            credentialExpiresAt: "2030-01-01T00:00:00.000Z"
          })
        );
      });
    });
    servers.push(server);
    const port = await listen(server);
    const enrollmentCode = `pw_enroll_${"b".repeat(43)}`;
    const handoff = encodedHandoff({
      workspaceId: "workspace-portable-operator",
      enrollmentCode,
      serverOrigin: `http://127.0.0.1:${port}`
    });
    const operator = new AgentHostOperator(null);
    const error = await operator.enrollHandoff(handoff, { installBackground: false }).then(
      () => null,
      (failure: unknown) => failure
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(handoff);
    expect(String(error)).not.toContain(enrollmentCode);

    const paths = resolveAgentHostDefaultPaths("workspace-portable-operator");
    const store = new FileHostCredentialStore(join(paths.dataDirectory, "credentials.json"));
    const pending = (await store.read())?.pending;
    expect(pending?.kind).toBe("host_enrollment_code");
    if (pending?.kind !== "host_enrollment_code") throw new Error("expected_pending");
    expect(pending.provenance?.kind).toBe("portable_handoff");
    expect(JSON.stringify(pending.provenance)).not.toContain(enrollmentCode);
    expect(String(error)).not.toContain(pending.credentialToken);

    await expect(
      operator.enrollHandoff(handoff, { installBackground: false })
    ).resolves.toMatchObject({
      state: "ready",
      credential: "active",
      background: "disabled",
      configPath: paths.configPath,
      agents: expect.arrayContaining([
        expect.objectContaining({ profileId: "codex-acp", exposed: false })
      ]),
      nextSteps: {
        listAgents: {
          command: "planweave-agent-host",
          args: ["agents", "list", "--config", paths.configPath]
        },
        exposeAgent: {
          args: ["agents", "expose", "<supported-profile>", "--config", paths.configPath]
        },
        hideAgent: {
          args: ["agents", "hide", "<supported-profile>", "--config", paths.configPath]
        }
      }
    });
    const failedBackground = {
      install: vi.fn().mockRejectedValue(
        new AgentHostBackgroundSetupError("check_scheduled_task_permissions", {
          cause: new Error("private scheduler output")
        })
      ),
      uninstall: vi.fn(),
      status: vi.fn(),
      restart: vi.fn()
    };
    await expect(
      new AgentHostOperator(failedBackground).enrollHandoff(handoff, {
        executablePath: "C:\\Program Files\\nodejs\\node.exe",
        fixedArgs: ["C:\\npm packages\\agent-host\\dist\\bin.js"]
      })
    ).resolves.toMatchObject({
      state: "background_setup_required",
      background: "setup_required",
      backgroundGuidance: "check_scheduled_task_permissions",
      configPath: paths.configPath
    });
    expect(failedBackground.install).toHaveBeenCalledWith(
      expect.objectContaining({
        executablePath: "C:\\Program Files\\nodejs\\node.exe",
        fixedArgs: ["C:\\npm packages\\agent-host\\dist\\bin.js"],
        configPath: paths.configPath
      })
    );
    failedBackground.install.mockClear();
    await new AgentHostOperator(failedBackground).enrollHandoff(handoff, {
      executablePath: "/opt/PlanWeave/planweave-agent-host"
    });
    expect(failedBackground.install).toHaveBeenCalledWith(
      expect.objectContaining({
        executablePath: "/opt/PlanWeave/planweave-agent-host",
        fixedArgs: []
      })
    );
    const config = await loadAgentHostConfig(paths.configPath);
    const restarted = await new FileHostCredentialStore(store.path).read();
    expect(restarted?.active?.provenance).toMatchObject(pending.provenance ?? {});
    expect(
      restarted?.active && verifyActivePortableHandoffProvenance(restarted.active, config)
    ).toBe(true);
    const raw = await readFile(store.path, "utf8");
    expect(raw).not.toContain(enrollmentCode);
    expect(raw).not.toContain(handoff);
    expect(raw).not.toContain(`http://127.0.0.1:${port}`);
  });

  it("does not backfill provenance onto an existing ordinary credential", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-portable-existing-"));
    directories.push(home);
    mockedHome.path = home;
    const workspaceId = "workspace-existing-active";
    const paths = resolveAgentHostDefaultPaths(workspaceId);
    const handoff = (await import("@planweave-ai/agent-host-protocol")).parseAgentHostSetupHandoff(
      encodedHandoff({ workspaceId }),
      new Date("2029-01-01T00:00:00.000Z")
    );
    const config = configFromAgentHostSetupHandoff(handoff, {
      paths,
      hostDisplayName: "Existing host"
    });
    await mkdir(join(config.workspaceRoot, workspaceId), { recursive: true, mode: 0o700 });
    await mkdir(join(paths.configPath, ".."), { recursive: true, mode: 0o700 });
    await writeFile(paths.configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
    const store = new FileHostCredentialStore(join(config.dataDirectory, "credentials.json"));
    await new AgentHostEnrollmentService(config, store, {
      exchange: async (request) => ({
        type: "host.enrollment.completed",
        protocolVersion: 1,
        enrollmentAttemptId: request.enrollmentAttemptId,
        hostId: "host-existing-active",
        workspaceId,
        credentialExpiresAt: "2030-01-01T00:00:00.000Z"
      })
    }).enroll(`pw_enroll_${"c".repeat(43)}`);

    await expect(
      new AgentHostOperator(null).enrollHandoff(encodedHandoff({ workspaceId }), {
        installBackground: false
      })
    ).resolves.toMatchObject({ state: "ready", credential: "active" });
    expect((await store.read())?.active?.provenance).toBeUndefined();

    await store.markRevoked();
    await expect(
      new AgentHostOperator(null).enrollHandoff(encodedHandoff({ workspaceId }), {
        installBackground: false
      })
    ).rejects.toThrow("agent_host_credential_unavailable");
    const revoked = await store.read();
    if (!revoked?.active) throw new Error("expected_active");
    await writeFile(
      store.path,
      `${JSON.stringify({
        version: revoked.version,
        active: { ...revoked.active, revokedAt: undefined, expiresAt: "2020-01-01T00:00:00.000Z" }
      })}\n`,
      { mode: 0o600 }
    );
    await expect(
      new AgentHostOperator(null).enrollHandoff(encodedHandoff({ workspaceId }), {
        installBackground: false
      })
    ).rejects.toThrow("agent_host_credential_unavailable");
  });

  it("rejects full endpoint drift in an existing config before creating pending state", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-portable-config-drift-"));
    directories.push(home);
    mockedHome.path = home;
    const workspaceId = "workspace-config-drift";
    const paths = resolveAgentHostDefaultPaths(workspaceId);
    const handoff = (await import("@planweave-ai/agent-host-protocol")).parseAgentHostSetupHandoff(
      encodedHandoff({ workspaceId }),
      new Date("2029-01-01T00:00:00.000Z")
    );
    const config = configFromAgentHostSetupHandoff(handoff, {
      paths,
      hostDisplayName: "Drifted host"
    });
    const drifted = {
      ...config,
      coordinator: {
        ...config.coordinator,
        endpoint: {
          ...handoff.endpoint,
          allowedClientOrigins: ["http://192.168.1.9:4317"]
        }
      }
    };
    await mkdir(join(paths.configPath, ".."), { recursive: true, mode: 0o700 });
    await writeFile(paths.configPath, `${JSON.stringify(drifted)}\n`, { mode: 0o600 });
    const store = new FileHostCredentialStore(join(config.dataDirectory, "credentials.json"));
    await expect(
      new AgentHostOperator(null).enrollHandoff(encodedHandoff({ workspaceId }), {
        installBackground: false
      })
    ).rejects.toThrow("agent_host_handoff_config_conflict");
    expect(await store.read()).toBeNull();
  });

  it("rejects ordinary or different portable pending state instead of upgrading or reusing it", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-portable-conflict-"));
    directories.push(home);
    mockedHome.path = home;
    const workspaceId = "workspace-pending-conflict";
    const paths = resolveAgentHostDefaultPaths(workspaceId);
    const firstEncoded = encodedHandoff({
      workspaceId,
      enrollmentCode: `pw_enroll_${"d".repeat(43)}`
    });
    const first = (await import("@planweave-ai/agent-host-protocol")).parseAgentHostSetupHandoff(
      firstEncoded,
      new Date("2029-01-01T00:00:00.000Z")
    );
    const config = configFromAgentHostSetupHandoff(first, {
      paths,
      hostDisplayName: "Pending host"
    });
    await mkdir(join(config.workspaceRoot, workspaceId), { recursive: true, mode: 0o700 });
    await mkdir(join(paths.configPath, ".."), { recursive: true, mode: 0o700 });
    await writeFile(paths.configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
    const store = new FileHostCredentialStore(join(config.dataDirectory, "credentials.json"));
    await store.begin(
      {
        kind: "host_enrollment_code",
        enrollmentAttemptId: "ordinary-attempt",
        enrollmentCode: first.enrollmentCode,
        credentialToken: `pw_host_${"e".repeat(43)}`,
        createdAt: "2029-01-01T00:00:00.000Z"
      },
      false
    );
    await expect(
      new AgentHostOperator(null).enrollHandoff(firstEncoded, { installBackground: false })
    ).rejects.toThrow("agent_host_handoff_pending_conflict");
    expect((await store.read())?.pending?.provenance).toBeUndefined();

    const acceptedAt = new Date("2029-01-01T00:00:00.000Z");
    await writeFile(
      store.path,
      `${JSON.stringify({
        version: "agent-host-credentials/v1",
        pending: {
          kind: "host_enrollment_code",
          enrollmentAttemptId: "portable-attempt",
          enrollmentCode: first.enrollmentCode,
          credentialToken: `pw_host_${"f".repeat(43)}`,
          createdAt: acceptedAt.toISOString(),
          provenance: createPendingPortableHandoffProvenance(first, acceptedAt)
        }
      })}\n`,
      { mode: 0o600 }
    );
    const differentHandoff = encodedHandoff({
      workspaceId,
      enrollmentCode: `pw_enroll_${"g".repeat(43)}`
    });
    await expect(
      new AgentHostOperator(null).enrollHandoff(differentHandoff, {
        installBackground: false
      })
    ).rejects.toThrow("agent_host_handoff_pending_conflict");
  });

  it("rejects a handoff while an ordinary replacement is pending beside active state", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-portable-replacement-"));
    directories.push(home);
    mockedHome.path = home;
    const workspaceId = "workspace-replacement-pending";
    const paths = resolveAgentHostDefaultPaths(workspaceId);
    const encoded = encodedHandoff({ workspaceId });
    const handoff = (await import("@planweave-ai/agent-host-protocol")).parseAgentHostSetupHandoff(
      encoded,
      new Date("2029-01-01T00:00:00.000Z")
    );
    const config = configFromAgentHostSetupHandoff(handoff, {
      paths,
      hostDisplayName: "Replacement host"
    });
    await mkdir(join(config.workspaceRoot, workspaceId), { recursive: true, mode: 0o700 });
    await mkdir(join(paths.configPath, ".."), { recursive: true, mode: 0o700 });
    await writeFile(paths.configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
    const store = new FileHostCredentialStore(join(config.dataDirectory, "credentials.json"));
    await new AgentHostEnrollmentService(config, store, {
      exchange: async (request) => ({
        type: "host.enrollment.completed",
        protocolVersion: 1,
        enrollmentAttemptId: request.enrollmentAttemptId,
        hostId: "host-replacement",
        workspaceId,
        credentialExpiresAt: "2030-01-01T00:00:00.000Z"
      })
    }).enroll(`pw_enroll_${"h".repeat(43)}`);
    await expect(
      new AgentHostEnrollmentService(config, store, {
        exchange: async () => {
          throw new Error("offline");
        }
      }).enroll(`pw_enroll_${"i".repeat(43)}`, { replaceExisting: true })
    ).rejects.toThrow("offline");
    const replacement = await store.read();
    expect(replacement?.active).toBeDefined();
    expect(replacement?.pending).toBeDefined();
    await expect(
      new AgentHostOperator(null).enrollHandoff(encoded, { installBackground: false })
    ).rejects.toThrow("agent_host_handoff_pending_conflict");
  });
});
