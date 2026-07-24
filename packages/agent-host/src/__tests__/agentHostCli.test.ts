import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHostOperator } from "../operator/agentHostOperator.js";
import {
  assertDurableStateReplacementSafe,
  ensureDurableHostIdentity
} from "../state/durableHostIdentity.js";
import {
  type AgentHostOperatorService,
  parseAgentHostArgs,
  runAgentHostCli,
  waitForAgentHostSignal
} from "../operator/cli.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

function operator(overrides: Partial<AgentHostOperatorService> = {}): AgentHostOperatorService {
  return {
    preflight: vi.fn(),
    enroll: vi.fn(),
    createDaemon: vi.fn(),
    status: vi.fn(),
    revoke: vi.fn(),
    ...overrides
  };
}

describe("Agent Host operator CLI", () => {
  it("preflights config, stores, workspaces, and profiles without exposing local paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-agent-host-cli-"));
    directories.push(root);
    await mkdir(join(root, "workspace", "project"), { recursive: true });
    const configPath = join(root, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: "agent-host-config/v1",
        coordinator: { url: "http://127.0.0.1:9999", allowInsecureDevelopment: true },
        dataDirectory: join(root, "data"),
        workspaceRoot: join(root, "workspace"),
        host: { displayName: "test-host", capacity: 1, capabilities: ["acp.test"] },
        workspaces: [{ id: "workspace-1", path: "project" }],
        agentProfiles: [
          {
            id: "profile-1",
            agentId: "agent-1",
            command: "/usr/bin/env",
            args: [],
            environment: []
          }
        ]
      })
    );

    const diagnostics = await new AgentHostOperator().preflight(configPath);
    expect(diagnostics).toMatchObject({
      credential: "missing",
      capabilities: ["acp.test"],
      capacity: 1,
      connection: "offline",
      recoverableExecutions: 0
    });
    expect(JSON.stringify(diagnostics)).not.toContain(root);
  });

  it("parses stable commands and rejects incomplete or unknown arguments", () => {
    expect(parseAgentHostArgs(["status", "--config", "/config.json"])).toEqual({
      command: "status",
      configPath: "/config.json",
      code: undefined,
      replace: false
    });
    expect(
      parseAgentHostArgs(["enroll", "--config", "/config.json", "--code", "once", "--replace"])
    ).toMatchObject({ command: "enroll", code: "once", replace: true });
    expect(() => parseAgentHostArgs(["enroll", "--config", "/config.json"])).toThrow(
      "agent_host_cli_enrollment_code_required"
    );
    expect(() => parseAgentHostArgs(["status", "--config", "/config.json", "--unknown"])).toThrow(
      "agent_host_cli_usage"
    );
  });

  it("uses service methods and maps usage and operational failures to exit codes", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const service = operator({ status: vi.fn().mockResolvedValue({ credential: "active" }) });
    await expect(
      runAgentHostCli(["status", "--config", "/private/config.json"], {
        operator: service,
        io: { stdout, stderr }
      })
    ).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith('{"credential":"active"}');
    expect(JSON.stringify(stdout.mock.calls)).not.toContain("/private/config.json");
    await expect(runAgentHostCli(["unknown"], { io: { stdout, stderr } })).resolves.toBe(2);
    expect(stderr).toHaveBeenLastCalledWith("agent_host_cli_usage");
  });

  it.each(["SIGINT", "SIGTERM"] as const)("shuts down once after %s", async (signal) => {
    const processLike = new EventEmitter();
    const composition = {
      start: vi.fn(),
      shutdown: vi.fn(),
      subscribeStatus: vi.fn((listener) => {
        listener({ state: "stopped" });
        return vi.fn();
      })
    };
    const running = waitForAgentHostSignal(composition, processLike as never);
    await vi.waitFor(() => expect(composition.start).toHaveBeenCalledOnce());
    processLike.emit(signal);
    await running;
    expect(composition.shutdown).toHaveBeenCalledOnce();
    expect(processLike.listenerCount("SIGINT")).toBe(0);
    expect(processLike.listenerCount("SIGTERM")).toBe(0);
  });

  it.each([
    [{ state: "auth-failed", reason: "credential_rejected" } as const, "agent_host_auth_failed"],
    [{ state: "degraded", reason: "protocol_rejected" } as const, "agent_host_transport_degraded"]
  ])("exits when the transport reaches terminal status", async (terminal, expectedError) => {
    let statusListener: ((status: typeof terminal | { state: "stopped" }) => void) | undefined;
    const composition = {
      subscribeStatus: vi.fn((listener) => {
        statusListener = listener;
        listener({ state: "stopped" });
        return vi.fn();
      }),
      start: vi.fn(() => statusListener?.(terminal)),
      shutdown: vi.fn()
    };
    const stderr = vi.fn();
    await expect(
      runAgentHostCli(["run", "--config", "/private/config.json"], {
        operator: operator({ createDaemon: vi.fn().mockResolvedValue(composition) }),
        io: { stdout: vi.fn(), stderr },
        processLike: new EventEmitter() as never
      })
    ).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith(expectedError);
    expect(composition.shutdown).toHaveBeenCalledOnce();
  });

  it("redacts arbitrary exceptions, paths, tokens, and payloads", async () => {
    const stderr = vi.fn();
    const privateValue = "/Users/operator/secret token=pw_host_secret prompt contents";
    const service = operator({ preflight: vi.fn().mockRejectedValue(new Error(privateValue)) });
    await expect(
      runAgentHostCli(["preflight", "--config", "/secret/config.json"], {
        operator: service,
        io: { stdout: vi.fn(), stderr }
      })
    ).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith("agent_host_failed");
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(privateValue);
  });

  it("reports a fixed CA error without exposing its path", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-agent-host-ca-cli-"));
    directories.push(root);
    await mkdir(join(root, "workspace"), { recursive: true });
    const privateCaPath = join(root, "private-ca.pem");
    const configPath = join(root, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: "agent-host-config/v1",
        coordinator: {
          url: "https://127.0.0.1:7443",
          caCertificatePath: privateCaPath
        },
        dataDirectory: join(root, "data"),
        workspaceRoot: join(root, "workspace"),
        host: { displayName: "test-host", capacity: 1, capabilities: ["acp.test"] },
        workspaces: [],
        agentProfiles: []
      })
    );
    const stderr = vi.fn();
    await expect(
      runAgentHostCli(["preflight", "--config", configPath], {
        io: { stdout: vi.fn(), stderr }
      })
    ).resolves.toBe(1);
    expect(stderr).toHaveBeenCalledWith("agent_host_ca_certificate_unreadable");
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(privateCaPath);
  });

  it("binds durable stores to one Host and refuses replacement after state exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-agent-host-identity-"));
    directories.push(root);
    const dataDirectory = join(root, "data");
    await ensureDurableHostIdentity(dataDirectory, "host-original");
    await expect(ensureDurableHostIdentity(dataDirectory, "host-original")).resolves.toBeUndefined();
    await expect(ensureDurableHostIdentity(dataDirectory, "host-replacement")).rejects.toThrow(
      "agent_host_durable_identity_mismatch"
    );
    await expect(assertDurableStateReplacementSafe(dataDirectory)).rejects.toThrow(
      "agent_host_reenrollment_requires_durable_state_export"
    );

    const orphanRoot = join(root, "orphan");
    const orphanData = join(orphanRoot, "data");
    await mkdir(orphanData, { recursive: true, mode: 0o700 });
    await writeFile(join(orphanData, "state.sqlite"), "legacy-state");
    await expect(ensureDurableHostIdentity(orphanData, "host-new")).rejects.toThrow(
      "agent_host_durable_identity_unbound"
    );
    const configPath = join(orphanRoot, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: "agent-host-config/v1",
        coordinator: { url: "http://127.0.0.1:9999", allowInsecureDevelopment: true },
        dataDirectory: orphanData,
        workspaceRoot: orphanRoot,
        host: { displayName: "orphan-host", capacity: 1, capabilities: ["acp.test"] },
        workspaces: [],
        agentProfiles: []
      })
    );
    await expect(
      new AgentHostOperator().enroll(configPath, `pw_enroll_${"a".repeat(43)}`)
    ).rejects.toThrow("agent_host_reenrollment_requires_durable_state_export");
  });
});
