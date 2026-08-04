import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseServerConfig, type ServerConfig } from "../config.js";
import { TailscaleExposureError } from "../exposure/errors.js";
import { ServerExposureManager } from "../exposure/serverExposureManager.js";
import type { TailscaleWebSocketProbe } from "../exposure/tailscaleWebSocketProbe.js";
import type {
  ExposureLeaseStorePort,
  TailscaleControlPort,
  TailscaleNodeState,
  TailscaleServeConfig,
  TailscaleServeLease,
  TailscaleServeState
} from "../exposure/types.js";
import { hashOperatorToken } from "../operatorAuth.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const hostPort = "planweave.tailnet.ts.net:443";

function config(): ServerConfig {
  return parseServerConfig({
    version: "server-config/v2",
    transport: {
      mode: "tailscale_https",
      listener: { protocol: "http", host: "127.0.0.1", port: 8787 },
      advertisedOrigin: "https://planweave.tailnet.ts.net"
    },
    deployment: {
      topology: "tailscale_https",
      serverOrigin: "https://planweave.tailnet.ts.net",
      allowedClientOrigins: ["https://planweave.tailnet.ts.net"],
      tlsTrust: "system_ca"
    },
    allowedClientOrigins: ["https://planweave.tailnet.ts.net"],
    dataDirectory: "/tmp/planweave-exposure-test",
    trustedProjects: [
      {
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "default",
        projectRoot: "/tmp/planweave-exposure-project"
      }
    ],
    operatorCredentials: [
      {
        operatorId: "admin",
        tokenSha256: hashOperatorToken(`pw_operator_${"E".repeat(43)}`),
        projectIds: [],
        serverAdmin: true
      }
    ]
  });
}

function serve(raw: Record<string, unknown>): TailscaleServeConfig {
  return { raw };
}

function exactRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    TCP: { "443": { HTTPS: true } },
    Web: { [hostPort]: { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } },
    AllowFunnel: {},
    Services: {},
    Foreground: {},
    ...overrides
  };
}

function nonTargetRaw(): Record<string, unknown> {
  return {
    TCP: { "8443": { TCPForward: "127.0.0.1:8443", UnknownTCP: { enabled: true } } },
    Web: {
      "other.tailnet.ts.net:8443": {
        Handlers: { "/": { Text: "other", UnknownHandler: 7 } },
        UnknownServer: "preserve"
      }
    },
    AllowFunnel: { "other.tailnet.ts.net:8443": true },
    Services: { "svc:other": { Tun: true, UnknownService: [1, 2] } },
    Foreground: {},
    FutureServeMetadata: { opaque: ["keep", 9] }
  };
}

function sameLease(left: TailscaleServeLease, right: TailscaleServeLease): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

class MemoryLeaseStore implements ExposureLeaseStorePort {
  lease: TailscaleServeLease | null = null;
  insertHook?: (lease: TailscaleServeLease) => boolean;
  replaceHook?: (expected: TailscaleServeLease, replacement: TailscaleServeLease) => boolean;
  load() {
    return this.lease;
  }
  insertIfAbsent(lease: TailscaleServeLease) {
    if (this.insertHook) return this.insertHook(lease);
    if (this.lease) return false;
    this.lease = lease;
    return true;
  }
  replaceExact(expected: TailscaleServeLease, replacement: TailscaleServeLease) {
    if (this.replaceHook) return this.replaceHook(expected, replacement);
    if (!this.lease || !sameLease(this.lease, expected)) return false;
    this.lease = replacement;
    return true;
  }
  deleteExact(lease: TailscaleServeLease) {
    if (!this.lease || !sameLease(this.lease, lease)) return false;
    this.lease = null;
    return true;
  }
}

class FakeTailscale implements TailscaleControlPort {
  readonly node: TailscaleNodeState = {
    version: "1.98.9",
    nodeIdentitySha256: digest("node"),
    dnsName: "planweave.tailnet.ts.net"
  };
  state: TailscaleServeState = { config: null };
  ensures = 0;
  releases = 0;
  beforePathOff?: () => void;
  async inspectNode() {
    return this.node;
  }
  async inspectServe() {
    return this.state;
  }
  async ensurePrivateHttps() {
    this.ensures += 1;
    const raw = structuredClone(this.state.config?.raw ?? {});
    const tcp = objectRecord(raw.TCP);
    const web = objectRecord(raw.Web);
    const funnel = objectRecord(raw.AllowFunnel);
    raw.TCP = { ...tcp, "443": { HTTPS: true } };
    raw.Web = {
      ...web,
      [hostPort]: { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } }
    };
    raw.AllowFunnel = { ...funnel, [hostPort]: false };
    raw.Services ??= {};
    raw.Foreground ??= {};
    this.state = { config: serve(raw) };
    return this.state;
  }
  async releasePrivateHttps() {
    this.releases += 1;
    this.beforePathOff?.();
    const raw = structuredClone(this.state.config?.raw ?? {});
    const web = objectRecord(raw.Web);
    const targetServer = objectRecord(web[hostPort]);
    const handlers = objectRecord(targetServer.Handlers);
    delete handlers["/"];
    if (Object.keys(handlers).length === 0) {
      delete web[hostPort];
      const tcp = objectRecord(raw.TCP);
      const funnel = objectRecord(raw.AllowFunnel);
      delete tcp["443"];
      delete funnel[hostPort];
      raw.TCP = tcp;
      raw.AllowFunnel = funnel;
    } else {
      web[hostPort] = { ...targetServer, Handlers: handlers };
    }
    raw.Web = web;
    this.state = { config: serve(raw) };
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function readyProbe(status: 200 | 503 = 503) {
  return async (_url: string, _options: { signal: AbortSignal }) => ({
    status,
    async json() {
      return { status: status === 200 ? "ready" : "listening", schemaVersion: 43 };
    }
  });
}

const successfulWebSocketProbe: TailscaleWebSocketProbe = async () => {};

async function createOwnedFixture(webSocketProbe = successfulWebSocketProbe) {
  const tailscale = new FakeTailscale();
  const leases = new MemoryLeaseStore();
  const manager = new ServerExposureManager({
    tailscale,
    leases,
    request: readyProbe(),
    webSocketProbe,
    clock: () => new Date("2026-08-03T00:00:00.000Z")
  });
  const prepared = await manager.activate(config());
  if (!prepared.ownership) throw new Error("expected_exposure_ownership");
  tailscale.ensures = 0;
  return { manager, tailscale, leases, ownership: prepared.ownership };
}

function expectCode(error: unknown, code: string): boolean {
  expect(error).toBeInstanceOf(TailscaleExposureError);
  expect((error as TailscaleExposureError).code).toBe(code);
  return true;
}

describe("ServerExposureManager", () => {
  it("requires the advertised external WSS readiness upgrade before reporting activation", async () => {
    const probes: Array<{ url: string; origin: string; aborted: boolean }> = [];
    const { manager, tailscale, leases, ownership } = await createOwnedFixture(
      async (url, { origin, signal }) => {
        probes.push({ url, origin, aborted: signal.aborted });
      }
    );
    expect(probes).toEqual([
      {
        url: "wss://planweave.tailnet.ts.net/readyz/ws",
        origin: "https://planweave.tailnet.ts.net",
        aborted: false
      }
    ]);
    expect(ownership.createdByActivation).toBe(true);
    await manager.release(ownership);
    expect(tailscale.releases).toBe(1);
    expect(leases.lease).toBeNull();
  });

  it("reuses an exactly owned route without external mutation", async () => {
    const { manager, tailscale, ownership } = await createOwnedFixture();
    const prepared = await manager.activate(config());
    expect(prepared.ownership).toEqual({ ...ownership, createdByActivation: false });
    expect(tailscale.ensures).toBe(0);
  });

  it.each([
    ["HTTP", { TCP: { "443": { HTTPS: true, HTTP: true } } }],
    ["TerminateTLS", { TCP: { "443": { HTTPS: true, TerminateTLS: "localhost:443" } } }],
    ["ProxyProtocol", { TCP: { "443": { HTTPS: true, ProxyProtocol: 1 } } }],
    [
      "AcceptAppCaps",
      {
        Web: {
          [hostPort]: {
            Handlers: {
              "/": { Proxy: "http://127.0.0.1:8787", AcceptAppCaps: true }
            }
          }
        }
      }
    ],
    [
      "Redirect",
      {
        Web: {
          [hostPort]: {
            Handlers: { "/": { Proxy: "http://127.0.0.1:8787", Redirect: "https://other" } }
          }
        }
      }
    ],
    [
      "unknown handler field",
      {
        Web: {
          [hostPort]: {
            Handlers: { "/": { Proxy: "http://127.0.0.1:8787", FutureBehavior: true } }
          }
        }
      }
    ],
    [
      "additional path",
      {
        Web: {
          [hostPort]: {
            Handlers: {
              "/": { Proxy: "http://127.0.0.1:8787" },
              "/other": { Text: "other" }
            }
          }
        }
      }
    ],
    ["Foreground", { Foreground: { "session-1": exactRaw() } }],
    ["Foreground null", { Foreground: null }],
    ["Foreground invalid", { Foreground: [] }]
  ])("fails closed for managed target behavior: %s", async (_name, override) => {
    const tailscale = new FakeTailscale();
    tailscale.state = { config: serve(exactRaw(override)) };
    const manager = new ServerExposureManager({
      tailscale,
      leases: new MemoryLeaseStore(),
      request: readyProbe(),
      webSocketProbe: successfulWebSocketProbe
    });
    await expect(manager.inspect(config())).rejects.toSatisfy((error: unknown) =>
      expectCode(error, "TAILSCALE_SERVE_CONFLICT")
    );
    expect(tailscale.releases).toBe(0);
  });

  it("preserves every opaque non-target field during activate and release", async () => {
    const tailscale = new FakeTailscale();
    const initial = nonTargetRaw();
    tailscale.state = { config: serve(structuredClone(initial)) };
    const leases = new MemoryLeaseStore();
    const manager = new ServerExposureManager({
      tailscale,
      leases,
      request: readyProbe(),
      webSocketProbe: successfulWebSocketProbe
    });
    const prepared = await manager.activate(config());
    if (!prepared.ownership) throw new Error("expected_exposure_ownership");
    await manager.release(prepared.ownership);
    expect(tailscale.state.config?.raw).toEqual(initial);
    expect(leases.lease).toBeNull();
  });

  it("retains the lease when another path races with path-exact off", async () => {
    const { manager, tailscale, leases, ownership } = await createOwnedFixture();
    tailscale.beforePathOff = () => {
      const raw = structuredClone(tailscale.state.config?.raw ?? {});
      const web = objectRecord(raw.Web);
      const target = objectRecord(web[hostPort]);
      web[hostPort] = {
        ...target,
        Handlers: {
          ...objectRecord(target.Handlers),
          "/concurrent": { Text: "winner" }
        }
      };
      raw.Web = web;
      tailscale.state = { config: serve(raw) };
    };
    await expect(manager.release(ownership)).rejects.toSatisfy((error: unknown) =>
      expectCode(error, "TAILSCALE_LEASE_DRIFT")
    );
    expect(tailscale.state.config?.raw).toMatchObject({
      Web: { [hostPort]: { Handlers: { "/concurrent": { Text: "winner" } } } }
    });
    expect(leases.lease).toEqual(ownership.lease);
  });

  it("does not call path off when an additional target handler already exists", async () => {
    const { manager, tailscale, leases, ownership } = await createOwnedFixture();
    const raw = structuredClone(tailscale.state.config?.raw ?? {});
    raw.Web = {
      [hostPort]: {
        Handlers: {
          "/": { Proxy: "http://127.0.0.1:8787" },
          "/existing": { Text: "keep" }
        }
      }
    };
    tailscale.state = { config: serve(raw) };
    await expect(manager.release(ownership)).rejects.toSatisfy((error: unknown) =>
      expectCode(error, "TAILSCALE_LEASE_DRIFT")
    );
    expect(tailscale.releases).toBe(0);
    expect(leases.lease).toEqual(ownership.lease);
  });

  it("aborts a bounded external probe and exactly cleans its newly acquired route", async () => {
    const tailscale = new FakeTailscale();
    const leases = new MemoryLeaseStore();
    let aborted = false;
    const manager = new ServerExposureManager({
      tailscale,
      leases,
      probeTimeoutMs: 10,
      webSocketProbe: successfulWebSocketProbe,
      request: async (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(Object.assign(new Error("aborted"), { code: "ABORT_ERR" }));
          });
        })
    });
    await expect(manager.activate(config())).rejects.toSatisfy((error: unknown) =>
      expectCode(error, "TAILSCALE_EXTERNAL_PROBE_FAILED")
    );
    expect(aborted).toBe(true);
    expect(tailscale.releases).toBe(1);
    expect(leases.lease).toBeNull();
  });

  it("fails closed on WSS upgrade failure and preserves every pre-existing route", async () => {
    const tailscale = new FakeTailscale();
    const initial = nonTargetRaw();
    tailscale.state = { config: serve(structuredClone(initial)) };
    const leases = new MemoryLeaseStore();
    const manager = new ServerExposureManager({
      tailscale,
      leases,
      request: readyProbe(200),
      webSocketProbe: async () => {
        throw Object.assign(new Error("upgrade rejected"), { code: "WS_UPGRADE_REJECTED" });
      }
    });

    await expect(manager.activate(config())).rejects.toSatisfy((error: unknown) =>
      expectCode(error, "TAILSCALE_EXTERNAL_PROBE_FAILED")
    );
    expect(tailscale.releases).toBe(1);
    expect(leases.lease).toBeNull();
    expect(tailscale.state.config?.raw).toEqual(initial);
  });

  it("bounds the WSS upgrade probe and exactly releases only its new route", async () => {
    const tailscale = new FakeTailscale();
    const initial = nonTargetRaw();
    tailscale.state = { config: serve(structuredClone(initial)) };
    const leases = new MemoryLeaseStore();
    let aborted = false;
    const manager = new ServerExposureManager({
      tailscale,
      leases,
      request: readyProbe(200),
      probeTimeoutMs: 10,
      webSocketProbe: async (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(Object.assign(new Error("aborted"), { code: "ABORT_ERR" }));
          });
        })
    });

    await expect(manager.activate(config())).rejects.toSatisfy((error: unknown) =>
      expectCode(error, "TAILSCALE_EXTERNAL_PROBE_FAILED")
    );
    expect(aborted).toBe(true);
    expect(tailscale.releases).toBe(1);
    expect(leases.lease).toBeNull();
    expect(tailscale.state.config?.raw).toEqual(initial);
  });

  it("reuses the precise concurrent CAS winner without deleting its route", async () => {
    const tailscale = new FakeTailscale();
    const leases = new MemoryLeaseStore();
    leases.insertHook = (candidate) => {
      leases.lease = {
        ...candidate,
        leaseId: "f".repeat(64),
        createdAt: "2026-08-03T00:00:01.000Z"
      };
      return false;
    };
    const manager = new ServerExposureManager({
      tailscale,
      leases,
      request: readyProbe(),
      webSocketProbe: successfulWebSocketProbe
    });
    const prepared = await manager.activate(config());
    expect(prepared.ownership).toEqual({
      kind: "tailscale_https",
      lease: leases.lease,
      createdByActivation: false
    });
    expect(tailscale.releases).toBe(0);
  });

  it("CAS-replaces its exact stale lease when the managed route is absent", async () => {
    const { manager, tailscale, leases, ownership } = await createOwnedFixture();
    leases.lease = {
      ...ownership.lease,
      leaseId: "e".repeat(64),
      createdAt: "2026-08-02T00:00:00.000Z"
    };
    tailscale.state = { config: null };
    const prepared = await manager.activate(config());
    expect(prepared.ownership?.createdByActivation).toBe(true);
    expect(prepared.ownership?.lease.leaseId).not.toBe("e".repeat(64));
    expect(leases.lease).toEqual(prepared.ownership?.lease);
    expect(tailscale.ensures).toBe(1);
  });

  it("fails closed and preserves the route when CAS loses to a different lease", async () => {
    const tailscale = new FakeTailscale();
    const leases = new MemoryLeaseStore();
    leases.insertHook = (candidate) => {
      leases.lease = { ...candidate, configFingerprint: "0".repeat(64) };
      return false;
    };
    const manager = new ServerExposureManager({
      tailscale,
      leases,
      request: readyProbe(),
      webSocketProbe: successfulWebSocketProbe
    });
    await expect(manager.activate(config())).rejects.toSatisfy((error: unknown) =>
      expectCode(error, "TAILSCALE_LEASE_PERSISTENCE_FAILED")
    );
    expect(tailscale.releases).toBe(0);
    expect(tailscale.state.config).not.toBeNull();
  });

  it.each([
    ["null", null],
    ["empty", serve({})],
    ["non-target-only", serve(nonTargetRaw())]
  ])("idempotently releases an absent target represented by %s", async (_name, state) => {
    const { manager, tailscale, leases, ownership } = await createOwnedFixture();
    tailscale.state = { config: state };
    await manager.release(ownership);
    expect(tailscale.releases).toBe(0);
    expect(leases.lease).toBeNull();
  });

  it("rejects an exact unowned route and origin mismatch without mutation", async () => {
    const tailscale = new FakeTailscale();
    tailscale.state = { config: serve(exactRaw()) };
    const manager = new ServerExposureManager({
      tailscale,
      leases: new MemoryLeaseStore(),
      request: readyProbe(),
      webSocketProbe: successfulWebSocketProbe
    });
    await expect(manager.inspect(config())).rejects.toSatisfy((error: unknown) =>
      expectCode(error, "TAILSCALE_SERVE_UNOWNED")
    );
    tailscale.node.dnsName = "other.tailnet.ts.net";
    await expect(manager.inspect(config())).rejects.toSatisfy((error: unknown) =>
      expectCode(error, "TAILSCALE_ORIGIN_MISMATCH")
    );
    expect(tailscale.releases).toBe(0);
  });
});
