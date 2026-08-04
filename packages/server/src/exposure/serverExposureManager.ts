import { createHash } from "node:crypto";
import { serverConfigSchema, type ServerConfig } from "../config.js";
import { serverReadinessSchema } from "../readiness.js";
import { tailscaleExposureFailure } from "./errors.js";
import {
  probeTailscaleWebSocketUpgrade,
  type TailscaleWebSocketProbe
} from "./tailscaleWebSocketProbe.js";
import {
  tailscaleServeLeaseSchema,
  type ExposureInspection,
  type ExposureLeaseStorePort,
  type ExposureOwnership,
  type PreparedServerExposure,
  type ServerExposureLifecyclePort,
  type TailscaleControlPort,
  type TailscaleNodeState,
  type TailscaleServeConfig,
  type TailscaleServeLease,
  type TailscaleServeState
} from "./types.js";

type ReadinessProbeResponse = {
  status: number;
  json(): Promise<unknown>;
};

type ReadinessRequest = (
  url: string,
  options: { signal: AbortSignal }
) => Promise<ReadinessProbeResponse>;

export type ServerExposureManagerOptions = {
  tailscale: TailscaleControlPort;
  leases: ExposureLeaseStorePort;
  request?: ReadinessRequest;
  webSocketProbe?: TailscaleWebSocketProbe;
  probeTimeoutMs?: number;
  clock?: () => Date;
};

type TailscaleTarget = {
  advertisedOrigin: string;
  backendOrigin: string;
  configFingerprint: string;
};

type TailscaleInspection = {
  target: TailscaleTarget;
  node: TailscaleNodeState;
  serve: TailscaleServeState;
  lease: TailscaleServeLease | null;
  route: "absent" | "exact" | "conflict";
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function targetFor(config: ServerConfig): TailscaleTarget {
  if (config.transport.mode !== "tailscale_https") {
    throw new Error("tailscale_exposure_transport_required");
  }
  const advertisedOrigin = new URL(config.transport.advertisedOrigin).origin;
  const backendOrigin = `http://127.0.0.1:${config.transport.listener.port}`;
  return {
    advertisedOrigin,
    backendOrigin,
    configFingerprint: sha256(
      `tailscale_https\0${advertisedOrigin}\0${backendOrigin}\0${config.databasePath}`
    )
  };
}

function expectedHostPort(target: TailscaleTarget): string {
  return `${new URL(target.advertisedOrigin).hostname}:443`;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
    .join(",")}}`;
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function section(
  raw: Readonly<Record<string, unknown>>,
  key: string
): Readonly<Record<string, unknown>> | null {
  return raw[key] === undefined ? {} : objectValue(raw[key]);
}

function managedRouteDigest(config: TailscaleServeConfig, target: TailscaleTarget): string {
  const hostPort = expectedHostPort(target);
  const tcp = section(config.raw, "TCP");
  const web = section(config.raw, "Web");
  const funnel = section(config.raw, "AllowFunnel");
  const foreground = section(config.raw, "Foreground");
  return sha256(
    canonicalize({
      tcp: tcp?.["443"] ?? null,
      web: web?.[hostPort] ?? null,
      allowFunnel: funnel?.[hostPort] ?? null,
      foreground: foreground ?? null
    })
  );
}

function nonTargetDigest(config: TailscaleServeConfig | null, target: TailscaleTarget): string {
  const hostPort = expectedHostPort(target);
  const raw = config?.raw ?? {};
  const projected: Record<string, unknown> = Object.fromEntries(
    Object.entries(raw).filter(([key]) => !["TCP", "Web", "AllowFunnel"].includes(key))
  );
  projected.Services ??= {};
  projected.Foreground ??= {};
  const tcp = section(raw, "TCP");
  projected.TCP = tcp
    ? Object.fromEntries(Object.entries(tcp).filter(([port]) => port !== "443"))
    : raw.TCP;
  const web = section(raw, "Web");
  if (web) {
    const projectedWeb: Record<string, unknown> = Object.fromEntries(
      Object.entries(web).filter(([host]) => host !== hostPort)
    );
    const targetServer = objectValue(web[hostPort]);
    if (targetServer) {
      const projectedServer: Record<string, unknown> = Object.fromEntries(
        Object.entries(targetServer).filter(([key]) => key !== "Handlers")
      );
      const handlers = objectValue(targetServer.Handlers);
      if (handlers) {
        const remainingHandlers = Object.fromEntries(
          Object.entries(handlers).filter(([path]) => path !== "/")
        );
        if (Object.keys(remainingHandlers).length > 0) projectedServer.Handlers = remainingHandlers;
      } else if (targetServer.Handlers !== undefined) {
        projectedServer.Handlers = targetServer.Handlers;
      }
      if (Object.keys(projectedServer).length > 0) projectedWeb[hostPort] = projectedServer;
    } else if (web[hostPort] !== undefined) {
      projectedWeb[hostPort] = web[hostPort];
    }
    projected.Web = projectedWeb;
  } else {
    projected.Web = raw.Web;
  }
  const funnel = section(raw, "AllowFunnel");
  projected.AllowFunnel = funnel
    ? Object.fromEntries(Object.entries(funnel).filter(([host]) => host !== hostPort))
    : raw.AllowFunnel;
  return sha256(canonicalize(projected));
}

function classifyRoute(
  config: TailscaleServeConfig | null,
  target: TailscaleTarget
): "absent" | "exact" | "conflict" {
  if (!config) return "absent";
  const raw = config.raw;
  const hostPort = expectedHostPort(target);
  const tcpSection = section(raw, "TCP");
  const webSection = section(raw, "Web");
  const funnelSection = section(raw, "AllowFunnel");
  const foregroundSection = section(raw, "Foreground");
  const services = section(raw, "Services");
  if (!tcpSection || !webSection || !funnelSection || !foregroundSection || !services) {
    return "conflict";
  }
  const tcp = tcpSection["443"];
  const web = webSection[hostPort];
  const funnel = funnelSection[hostPort];
  if (Object.keys(foregroundSection).length > 0) return "conflict";
  if (tcp === undefined && web === undefined && funnel === undefined) {
    return "absent";
  }
  const tcpHandler = objectValue(tcp);
  const webServer = objectValue(web);
  const handlers = webServer ? objectValue(webServer.Handlers) : null;
  const root = handlers?.["/"];
  const rootHandler = objectValue(root);
  const exact =
    tcpHandler !== null &&
    exactKeys(tcpHandler, ["HTTPS"]) &&
    tcpHandler.HTTPS === true &&
    webServer !== null &&
    exactKeys(webServer, ["Handlers"]) &&
    handlers !== null &&
    exactKeys(handlers, ["/"]) &&
    rootHandler !== null &&
    exactKeys(rootHandler, ["Proxy"]) &&
    rootHandler.Proxy === target.backendOrigin &&
    (funnel === undefined || funnel === false);
  return exact ? "exact" : "conflict";
}

function leaseMatchesTarget(
  lease: TailscaleServeLease,
  target: TailscaleTarget,
  node: TailscaleNodeState
): boolean {
  return (
    lease.configFingerprint === target.configFingerprint &&
    lease.nodeIdentitySha256 === node.nodeIdentitySha256 &&
    lease.advertisedOrigin === target.advertisedOrigin &&
    lease.httpsPort === 443 &&
    lease.path === "/" &&
    lease.backendOrigin === target.backendOrigin
  );
}

function sameLease(left: TailscaleServeLease, right: TailscaleServeLease): boolean {
  return (
    left.leaseId === right.leaseId &&
    left.configFingerprint === right.configFingerprint &&
    left.nodeIdentitySha256 === right.nodeIdentitySha256 &&
    left.advertisedOrigin === right.advertisedOrigin &&
    left.httpsPort === right.httpsPort &&
    left.path === right.path &&
    left.backendOrigin === right.backendOrigin &&
    left.serveConfigSha256 === right.serveConfigSha256 &&
    left.createdAt === right.createdAt
  );
}

export class ServerExposureManager implements ServerExposureLifecyclePort {
  private readonly request: ReadinessRequest;
  private readonly webSocketProbe: TailscaleWebSocketProbe;
  private readonly clock: () => Date;
  private readonly probeTimeoutMs: number;

  constructor(private readonly options: ServerExposureManagerOptions) {
    this.request = options.request ?? ((url, requestOptions) => fetch(url, requestOptions));
    this.webSocketProbe = options.webSocketProbe ?? probeTailscaleWebSocketUpgrade;
    this.clock = options.clock ?? (() => new Date());
    this.probeTimeoutMs = options.probeTimeoutMs ?? 5_000;
  }

  async inspect(rawConfig: ServerConfig): Promise<ExposureInspection> {
    const config = serverConfigSchema.parse(rawConfig);
    if (config.transport.mode !== "tailscale_https") {
      return {
        state: "not_applicable",
        listener: config.transport.listener,
        advertisedOrigin: config.transport.advertisedOrigin
      };
    }
    const inspected = await this.inspectTailscale(config);
    this.assertInspectionSafe(inspected);
    return {
      state: inspected.route === "exact" ? "ready" : "available",
      listener: config.transport.listener,
      advertisedOrigin: config.transport.advertisedOrigin
    };
  }

  async activate(rawConfig: ServerConfig): Promise<PreparedServerExposure> {
    const config = serverConfigSchema.parse(rawConfig);
    if (config.transport.mode !== "tailscale_https") {
      return {
        listener: config.transport.listener,
        advertisedOrigin: config.transport.advertisedOrigin
      };
    }
    const inspected = await this.inspectTailscale(config);
    this.assertInspectionSafe(inspected);
    if (inspected.route === "exact") {
      const lease = inspected.lease;
      if (!lease) throw tailscaleExposureFailure("TAILSCALE_SERVE_UNOWNED");
      await this.probe(inspected.target.advertisedOrigin);
      return {
        listener: config.transport.listener,
        advertisedOrigin: config.transport.advertisedOrigin,
        ownership: { kind: "tailscale_https", lease, createdByActivation: false }
      };
    }

    const preservedDigest = nonTargetDigest(inspected.serve.config, inspected.target);
    const createdState = await this.options.tailscale.ensurePrivateHttps({
      advertisedOrigin: inspected.target.advertisedOrigin,
      backendOrigin: inspected.target.backendOrigin
    });
    if (classifyRoute(createdState.config, inspected.target) !== "exact" || !createdState.config) {
      throw tailscaleExposureFailure("TAILSCALE_SERVE_CONFLICT");
    }
    if (nonTargetDigest(createdState.config, inspected.target) !== preservedDigest) {
      throw tailscaleExposureFailure("TAILSCALE_LEASE_DRIFT");
    }
    const lease = this.createLease(
      inspected.target,
      inspected.node,
      managedRouteDigest(createdState.config, inspected.target)
    );
    let acquired: boolean;
    try {
      acquired = inspected.lease
        ? this.options.leases.replaceExact(inspected.lease, lease)
        : this.options.leases.insertIfAbsent(lease);
    } catch (error) {
      throw tailscaleExposureFailure("TAILSCALE_LEASE_PERSISTENCE_FAILED", this.safeCause(error));
    }
    if (!acquired) {
      let concurrentLease: TailscaleServeLease | null;
      try {
        concurrentLease = this.options.leases.load();
      } catch (error) {
        throw tailscaleExposureFailure("TAILSCALE_LEASE_PERSISTENCE_FAILED", this.safeCause(error));
      }
      if (
        !concurrentLease ||
        !leaseMatchesTarget(concurrentLease, inspected.target, inspected.node) ||
        concurrentLease.serveConfigSha256 !==
          managedRouteDigest(createdState.config, inspected.target)
      ) {
        throw tailscaleExposureFailure("TAILSCALE_LEASE_PERSISTENCE_FAILED");
      }
      await this.probe(inspected.target.advertisedOrigin);
      return {
        listener: config.transport.listener,
        advertisedOrigin: config.transport.advertisedOrigin,
        ownership: {
          kind: "tailscale_https",
          lease: concurrentLease,
          createdByActivation: false
        }
      };
    }
    try {
      await this.probe(inspected.target.advertisedOrigin);
    } catch (error) {
      try {
        await this.release({ kind: "tailscale_https", lease, createdByActivation: true });
      } catch (cleanupError) {
        throw tailscaleExposureFailure(
          "TAILSCALE_EXTERNAL_PROBE_FAILED",
          new AggregateError(
            [this.safeCause(error), this.safeCause(cleanupError)],
            "tailscale_probe_and_cleanup_failed"
          )
        );
      }
      throw error;
    }
    return {
      listener: config.transport.listener,
      advertisedOrigin: config.transport.advertisedOrigin,
      ownership: { kind: "tailscale_https", lease, createdByActivation: true }
    };
  }

  async release(ownership: ExposureOwnership): Promise<void> {
    const supplied = tailscaleServeLeaseSchema.parse(ownership.lease);
    const persisted = this.options.leases.load();
    if (!persisted || !sameLease(persisted, supplied)) {
      throw tailscaleExposureFailure("TAILSCALE_LEASE_DRIFT");
    }
    const node = await this.options.tailscale.inspectNode();
    if (node.nodeIdentitySha256 !== persisted.nodeIdentitySha256) {
      throw tailscaleExposureFailure("TAILSCALE_LEASE_DRIFT");
    }
    const target = {
      advertisedOrigin: persisted.advertisedOrigin,
      backendOrigin: persisted.backendOrigin,
      configFingerprint: persisted.configFingerprint
    };
    const serve = await this.options.tailscale.inspectServe();
    const route = classifyRoute(serve.config, target);
    if (route === "absent") {
      if (!this.options.leases.deleteExact(persisted)) {
        throw tailscaleExposureFailure("TAILSCALE_LEASE_DRIFT");
      }
      return;
    }
    if (
      route !== "exact" ||
      !serve.config ||
      managedRouteDigest(serve.config, target) !== persisted.serveConfigSha256
    ) {
      throw tailscaleExposureFailure("TAILSCALE_LEASE_DRIFT");
    }
    const preservedDigest = nonTargetDigest(serve.config, target);
    await this.options.tailscale.releasePrivateHttps(persisted);
    const after = await this.options.tailscale.inspectServe();
    if (
      classifyRoute(after.config, target) !== "absent" ||
      nonTargetDigest(after.config, target) !== preservedDigest ||
      !this.options.leases.deleteExact(persisted)
    ) {
      throw tailscaleExposureFailure("TAILSCALE_LEASE_DRIFT");
    }
  }

  private async inspectTailscale(config: ServerConfig): Promise<TailscaleInspection> {
    const target = targetFor(config);
    const node = await this.options.tailscale.inspectNode();
    if (node.dnsName !== new URL(target.advertisedOrigin).hostname.toLowerCase()) {
      throw tailscaleExposureFailure("TAILSCALE_ORIGIN_MISMATCH");
    }
    const serve = await this.options.tailscale.inspectServe();
    return {
      target,
      node,
      serve,
      lease: this.options.leases.load(),
      route: classifyRoute(serve.config, target)
    };
  }

  private assertInspectionSafe(inspected: TailscaleInspection): void {
    if (inspected.route === "conflict") {
      throw tailscaleExposureFailure(
        inspected.lease ? "TAILSCALE_LEASE_DRIFT" : "TAILSCALE_SERVE_CONFLICT"
      );
    }
    if (inspected.route === "exact") {
      if (!inspected.lease) throw tailscaleExposureFailure("TAILSCALE_SERVE_UNOWNED");
      if (
        !leaseMatchesTarget(inspected.lease, inspected.target, inspected.node) ||
        !inspected.serve.config ||
        inspected.lease.serveConfigSha256 !==
          managedRouteDigest(inspected.serve.config, inspected.target)
      ) {
        throw tailscaleExposureFailure("TAILSCALE_LEASE_DRIFT");
      }
      return;
    }
    if (inspected.lease && !leaseMatchesTarget(inspected.lease, inspected.target, inspected.node)) {
      throw tailscaleExposureFailure("TAILSCALE_LEASE_DRIFT");
    }
  }

  private createLease(
    target: TailscaleTarget,
    node: TailscaleNodeState,
    serveConfigSha256: string
  ): TailscaleServeLease {
    const createdAt = this.clock().toISOString();
    return tailscaleServeLeaseSchema.parse({
      leaseId: sha256(
        `${target.configFingerprint}\0${node.nodeIdentitySha256}\0${serveConfigSha256}\0${createdAt}`
      ),
      configFingerprint: target.configFingerprint,
      nodeIdentitySha256: node.nodeIdentitySha256,
      advertisedOrigin: target.advertisedOrigin,
      httpsPort: 443,
      path: "/",
      backendOrigin: target.backendOrigin,
      serveConfigSha256,
      createdAt
    });
  }

  private async probe(origin: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.probeTimeoutMs);
    try {
      const response = await this.request(`${origin}/readyz`, { signal: controller.signal });
      const readiness = serverReadinessSchema.safeParse(await response.json());
      const reachable =
        readiness.success &&
        ((response.status === 200 && readiness.data.status === "ready") ||
          (response.status === 503 && readiness.data.status === "listening"));
      if (!reachable) throw new Error("tailscale_readiness_response_invalid");
      const webSocketOrigin = new URL(origin);
      webSocketOrigin.protocol = "wss:";
      webSocketOrigin.pathname = "/readyz/ws";
      await this.webSocketProbe(webSocketOrigin.href, {
        origin,
        signal: controller.signal
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TailscaleExposureError") throw error;
      throw tailscaleExposureFailure("TAILSCALE_EXTERNAL_PROBE_FAILED", this.safeCause(error));
    } finally {
      clearTimeout(timeout);
    }
  }

  private safeCause(error: unknown): Error {
    const code =
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : "UNKNOWN";
    return new Error(`tailscale_exposure_failure:${code}`);
  }
}
