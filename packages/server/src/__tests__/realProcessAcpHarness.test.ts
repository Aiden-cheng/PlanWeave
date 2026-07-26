import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FakeAcpControl,
  RealProcessAcpHarness,
  REAL_PROCESS_ACP_HARNESS_DEFAULT_TIMEOUT_MS,
  acpMockAgentPath,
  allocateEphemeralPort,
  stopManagedChildForCleanup,
  type ManagedChild
} from "./support/realProcessAcpHarness.js";
import { createServer } from "node:http";

const harnesses: RealProcessAcpHarness[] = [];
const managedChildren: ManagedChild[] = [];

afterEach(async () => {
  for (const child of managedChildren.splice(0)) {
    if (child.tree.isAlive()) {
      await child.tree.terminate("test cleanup");
    }
  }
  await Promise.all(
    harnesses.splice(0).map(async (harness) => {
      await harness.dispose();
    })
  );
});

async function createHarness(
  options?: Parameters<typeof RealProcessAcpHarness.create>[0]
): Promise<RealProcessAcpHarness> {
  const harness = await RealProcessAcpHarness.create(options);
  harnesses.push(harness);
  return harness;
}

describe("real-process ACP harness", () => {
  it("falls back to root termination when process-group cleanup is denied", async () => {
    const harness = await createHarness();
    await mkdir(harness.paths.control, { recursive: true });
    const child = harness.spawnFakeAcpDirect();
    managedChildren.push(child);
    const denied = Object.assign(new Error("process-group cleanup denied"), { code: "EPERM" });

    await expect(
      stopManagedChildForCleanup(
        {
          ...child,
          tree: {
            ...child.tree,
            isAlive: () => true,
            terminate: async () => Promise.reject(denied)
          }
        },
        "fallback contract test"
      )
    ).resolves.toBeUndefined();
    await expect(child.exit).resolves.toMatchObject({ signal: "SIGKILL" });
  });

  it("allocates exclusive loopback ports without leaking the probe listener", async () => {
    for (let index = 0; index < 5; index++) {
      const port = await allocateEphemeralPort();
      expect(port).toBeGreaterThan(0);
      // Port must be free for a real process bind after allocation returns.
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve());
      });
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("starts Server and Host as real processes, enrolls via public API, and reaches readiness", async () => {
    const harness = await createHarness();
    await harness.startAll();

    expect((await fetch(`${harness.origin}/healthz`)).status).toBe(200);
    await expect((await fetch(`${harness.origin}/readyz`)).json()).resolves.toMatchObject({
      status: "ready"
    });
    expect(harness.serverPid()).toEqual(expect.any(Number));
    expect(harness.hostPid()).toEqual(expect.any(Number));
    expect(existsSync(harness.paths.serverData)).toBe(true);
    expect(existsSync(harness.paths.hostData)).toBe(true);
    expect(acpMockAgentPath.endsWith("acpMockAgent.mjs")).toBe(true);

    const hosts = (await (
      await fetch(`${harness.origin}/api/v1/hosts`, { headers: harness.authorizationHeaders() })
    ).json()) as { items: Array<{ displayName: string; capacity: number }> };
    expect(hosts.items[0]).toMatchObject({
      displayName: "Harness Host",
      capacity: 2
    });
  }, 30_000);

  it("surfaces failed Server startup with timeout diagnostics (redacted logs)", async () => {
    const harness = await createHarness({
      corruptServerConfigOnCreate: true,
      readinessTimeoutMs: 1_500
    });
    let message = "";
    try {
      await harness.startServer();
      expect.fail("expected server start to fail");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/real_process_harness_timeout:server-ready/);
    expect(message).toContain("serverPid=");
    expect(message).toMatch(/server\.(stdout|stderr):/);
    // Operator token material must not appear unredacted in diagnostics even if echoed.
    expect(message).not.toMatch(/harness_operator_token_abcdefghijklmnopqrstuvwxyz/);
  }, 15_000);

  it("controls fake ACP barriers and resume without production debug endpoints", async () => {
    const harness = await createHarness();
    await mkdir(harness.paths.control, { recursive: true });
    const control = new FakeAcpControl(harness.paths.control);
    await control.pause(["initialize"]);

    const child = harness.spawnFakeAcpDirect("success");
    managedChildren.push(child);
    await control.waitUntilReady(REAL_PROCESS_ACP_HARNESS_DEFAULT_TIMEOUT_MS);

    // Write initialize request over stdio; response should block until resume.
    let initializeResolved = false;
    const initializePromise = new Promise<{ ok: boolean; body: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("initialize response timed out")), 10_000);
      let buffer = "";
      child.child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        for (const line of buffer.split("\n")) {
          if (!line.trim().startsWith("{")) continue;
          try {
            const message = JSON.parse(line) as { id?: number; result?: unknown };
            if (message.id === 1 && message.result) {
              initializeResolved = true;
              clearTimeout(timer);
              resolve({ ok: true, body: line });
            }
          } catch {
            // ignore partial frames
          }
        }
      });
      child.child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: "harness-barrier", version: "1.0.0" }
          }
        })}\n`
      );
    });

    await control.waitUntilLifecycleContains("paused initialize");
    expect(initializeResolved).toBe(false);
    await control.resume();
    await expect(initializePromise).resolves.toMatchObject({ ok: true });
    expect(initializeResolved).toBe(true);

    await child.tree.terminate("barrier test done");
    await child.exit;
    managedChildren.splice(managedChildren.indexOf(child), 1);
  }, 20_000);

  it("restarts Server and Host while preserving durable enrollment state", async () => {
    const harness = await createHarness();
    await harness.startAll();
    const first = await harness.waitForHostOnline();

    const second = await harness.restartHost({ previousLastSeenAt: first.lastSeenAt });
    expect(second.id).toBe(first.id);
    expect(second.lastSeenAt).not.toBe(first.lastSeenAt);

    await harness.restartServer();
    await expect((await fetch(`${harness.origin}/readyz`)).json()).resolves.toMatchObject({
      status: "ready"
    });
    // Host was still running across Server restart; reconnect should refresh lastSeenAt.
    await harness.waitForHostOnline({ lastSeenAtNot: second.lastSeenAt });

    const status = await harness.runHostCommand(["status", "--config", harness.paths.hostConfig]);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ credential: "active" });
  }, 45_000);

  it("exposes timeout diagnostics and kill/close transport fault controls", async () => {
    const harness = await createHarness();
    await harness.startServer();
    await harness.waitForServerReadyz();

    // Host not started: waiting for online should time out with diagnostics.
    await expect(harness.waitForHostOnline({ timeoutMs: 800 })).rejects.toThrow(
      /real_process_harness_timeout:host-online/
    );

    await harness.enrollHost();
    await harness.startHost();
    const hostPid = harness.hostPid();
    expect(hostPid).toEqual(expect.any(Number));

    await harness.closeServerTransport();
    expect(harness.serverPid()).toBeUndefined();
    await expect(fetch(`${harness.origin}/readyz`)).rejects.toThrow();

    await harness.killHost("SIGKILL");
    expect(harness.hostPid()).toBeUndefined();
    expect(
      harness.hostExitSnapshot()?.signal === "SIGKILL" || harness.hostExitSnapshot()?.code !== 0
    ).toBe(true);

    expect(() => harness.advanceInjectedClock(1_000)).toThrow(
      /real_process_acp_harness_clock_not_supported/
    );

    await harness.corruptScopedPayload("host-config");
    const raw = await import("node:fs/promises").then((fs) =>
      fs.readFile(harness.paths.hostConfig, "utf8")
    );
    expect(raw.startsWith("{corrupt-host-config")).toBe(true);
  }, 30_000);

  it("cleanup terminates children and removes only harness-created paths", async () => {
    const harness = await createHarness();
    await harness.startAll();
    const roots = {
      root: harness.paths.root,
      projectRoot: harness.paths.projectRoot,
      projectHome: harness.paths.projectHome
    };
    const serverPid = harness.serverPid();
    const hostPid = harness.hostPid();
    expect(serverPid).toEqual(expect.any(Number));
    expect(hostPid).toEqual(expect.any(Number));

    // Marker outside harness ownership must survive dispose.
    const externalMarker = join(process.cwd(), `.harness-external-marker-${process.pid}`);
    await writeFile(externalMarker, "keep\n", "utf8");

    await harness.dispose();
    // Remove from afterEach list — already disposed.
    harnesses.splice(harnesses.indexOf(harness), 1);

    expect(existsSync(roots.root)).toBe(false);
    expect(existsSync(roots.projectRoot)).toBe(false);
    expect(existsSync(roots.projectHome)).toBe(false);
    expect(existsSync(externalMarker)).toBe(true);
    await import("node:fs/promises").then((fs) => fs.rm(externalMarker, { force: true }));

    // Processes should be gone (best-effort check via kill(0) semantics).
    if (serverPid !== undefined) {
      expect(() => process.kill(serverPid, 0)).toThrow();
    }
    if (hostPid !== undefined) {
      expect(() => process.kill(hostPid, 0)).toThrow();
    }
  }, 30_000);
});
