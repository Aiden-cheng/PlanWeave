import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { ArtifactStore } from "./artifacts.js";
import { handleAgentHostArtifactRequest } from "./artifactHttp.js";
import {
  CommentAttachmentBlobStore,
  CommentAttachmentRepository,
  CommentAttachmentService,
  handleCommentAttachmentHttpRequest
} from "./attachments/index.js";
import { serverConfigSchema, type ServerConfig } from "./config.js";
import { startRemoteBlockCoordinationServer } from "./distributedCoordination.js";
import { HostEnrollmentService } from "./hostEnrollment.js";
import { handleHostEnrollmentRequest } from "./hostEnrollmentHttp.js";
import {
  handleHumanHttpRequest,
  HumanIdentityRepository,
  HumanMembershipService
} from "./identity/index.js";
import { OperatorTokenRegistry } from "./operatorAuth.js";
import { handleOperatorHttpRequest } from "./operatorHttp.js";
import { serverPackageVersion } from "./packageInfo.js";
import { ServerReadinessController, type ServerReadiness } from "./readiness.js";
import { RemoteControlService } from "./remoteControlService.js";
import {
  ArtifactStoreRemoteContent,
  RuntimeInputArtifactMaterializer
} from "./runtimeArtifactAdapter.js";
import { createTrustedRuntimeRegistry } from "./runtimeProjectRegistry.js";
import { attachAgentHostWebSocketServer, type AgentHostWebSocketServer } from "./wsServer.js";

export type DistributedServerCompositionOptions = {
  httpServer: HttpServer;
  config: ServerConfig;
  clock?: () => Date;
  readiness?: ServerReadinessController;
};

export type DistributedServerComposition = {
  readonly ownsHttpServer: false;
  readiness(): ServerReadiness;
  beginDrain(): void;
  drainTransports(): Promise<void>;
  close(): Promise<void>;
};

async function waitForInflightRequests(
  requests: ReadonlySet<Promise<void>>,
  timeoutMs: number
): Promise<void> {
  if (requests.size === 0) return;
  const settled = Promise.allSettled([...requests]).then(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    settled.then(() => false),
    new Promise<true>((resolve) => {
      timer = setTimeout(() => {
        resolve(true);
      }, timeoutMs);
    })
  ]);
  if (timer) clearTimeout(timer);
  if (timedOut) throw new Error("server_http_inflight_drain_timeout");
}

async function drainCompositionTransports(input: {
  httpServer: HttpServer;
  requestListener?: (request: IncomingMessage, response: ServerResponse) => void;
  webSockets?: AgentHostWebSocketServer;
  inflightRequests: ReadonlySet<Promise<void>>;
  shutdownTimeoutMs: number;
}): Promise<void> {
  const errors: unknown[] = [];
  if (input.requestListener) input.httpServer.off("request", input.requestListener);
  try {
    await input.webSockets?.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await waitForInflightRequests(input.inflightRequests, input.shutdownTimeoutMs);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0)
    throw new AggregateError(errors, "distributed_server_transport_drain_failed");
}

function closeCompositionStorage(input: {
  closeLifecycle?: () => void;
  closeRuntimeRegistry(): void;
}): void {
  const errors: unknown[] = [];
  try {
    input.closeLifecycle?.();
  } catch (error) {
    errors.push(error);
  }
  try {
    input.closeRuntimeRegistry();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, "distributed_server_cleanup_failed");
}

function containsCleanupError(error: unknown, code: string): boolean {
  if (error instanceof Error && error.message === code) return true;
  return error instanceof AggregateError
    ? error.errors.some((nested) => containsCleanupError(nested, code))
    : false;
}

function respond(response: ServerResponse, status: number, code: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const bytes = Buffer.from(JSON.stringify({ error: code }));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength,
    "cache-control": "no-store"
  });
  response.end(bytes);
}

function requiresAdmission(request: IncomingMessage): boolean {
  if (request.method !== "POST") return false;
  const pathname = new URL(request.url ?? "/", "http://planweave.invalid").pathname;
  return (
    pathname === "/agent-hosts/enrollments/exchange" ||
    pathname === "/api/v1/host-enrollments" ||
    pathname === "/api/v1/remote-operations" ||
    /^\/api\/v1\/remote-operations\/[^/]+\/actions$/.test(pathname) ||
    /^\/api\/v1\/remote-operations\/[^/]+\/interactions\/respond$/.test(pathname) ||
    /^\/api\/v1\/projects\/[^/]+\/human\//.test(pathname) ||
    /^\/api\/v1\/projects\/[^/]+\/attachments(\/|$)/.test(pathname)
  );
}

export async function createDistributedServerComposition(
  options: DistributedServerCompositionOptions
): Promise<DistributedServerComposition> {
  const config = serverConfigSchema.parse(options.config);
  const clock = options.clock ?? (() => new Date());
  const readiness = options.readiness ?? new ServerReadinessController();
  const runtimeRegistry = await createTrustedRuntimeRegistry(config.trustedProjects);
  let lifecycle: Awaited<ReturnType<typeof startRemoteBlockCoordinationServer>> | undefined;
  let artifactStore: ArtifactStore | undefined;
  let webSockets: AgentHostWebSocketServer | undefined;
  let requestListener: ((request: IncomingMessage, response: ServerResponse) => void) | undefined;
  const inflightRequests = new Set<Promise<void>>();
  try {
    const authorization = new OperatorTokenRegistry(config.operatorCredentials);
    readiness.transition("migrating");
    lifecycle = await startRemoteBlockCoordinationServer(
      {
        dataDirectory: config.dataDirectory,
        databasePath: config.databasePath,
        busyTimeoutMs: config.limits.busyTimeoutMs
      },
      (database) => {
        readiness.transition("reconciling");
        artifactStore = new ArtifactStore(
          database,
          config.dataDirectory,
          config.limits.maxArtifactBytes
        );
        return {
          leaseDurationMs: config.limits.leaseDurationMs,
          hostOfflineAfterMs: config.limits.hostOfflineAfterMs,
          clock,
          runtimeResolver: runtimeRegistry.registry,
          inputArtifacts: new RuntimeInputArtifactMaterializer(
            runtimeRegistry.registry,
            artifactStore
          ),
          artifactContent: new ArtifactStoreRemoteContent(artifactStore),
          interactionAuthorization: authorization,
          eventRetentionMaxEvents: config.limits.eventRetentionMaxEvents,
          eventRetentionMaxBytes: config.limits.eventRetentionMaxBytes
        };
      }
    );
    if (!artifactStore) throw new Error("artifact_store_not_initialized");
    const initializedArtifactStore = artifactStore;
    const { coordination, server } = lifecycle;
    const schemaVersion = server.readiness().schemaVersion;
    readiness.transition("reconciling", schemaVersion);
    const enrollments = new HostEnrollmentService(server.database, clock);
    const humanIdentity = new HumanIdentityRepository(server.database, clock);
    const humanMembership = new HumanMembershipService({
      repository: humanIdentity,
      clock
    });
    const commentAttachmentRepository = new CommentAttachmentRepository(server.database);
    const commentAttachmentBlobs = new CommentAttachmentBlobStore(
      server.database,
      config.dataDirectory
    );
    const commentAttachments = new CommentAttachmentService({
      repository: commentAttachmentRepository,
      blobs: commentAttachmentBlobs,
      clock
    });
    webSockets = attachAgentHostWebSocketServer({
      server: options.httpServer,
      hosts: coordination.hosts,
      mailbox: coordination.mailbox,
      dispatches: coordination.dispatches,
      acpEvents: coordination.acpEvents,
      interactions: coordination.interactions,
      actions: coordination.actions,
      heartbeatIntervalMs: config.limits.heartbeatIntervalMs,
      leaseDurationMs: config.limits.leaseDurationMs,
      maxPayloadBytes: config.limits.maxWebSocketPayloadBytes,
      shutdownTimeoutMs: config.limits.shutdownTimeoutMs,
      allowInsecureTransport: config.allowInsecureDevelopment
    });
    const attachedWebSockets = webSockets;
    const control = new RemoteControlService({
      authorization,
      enrollments,
      hosts: coordination.hosts,
      operations: coordination.operations,
      dispatches: coordination.dispatches,
      coordinator: coordination.coordinator,
      events: coordination.acpEvents,
      interactions: coordination.interactions,
      disconnectHost: (hostId) => attachedWebSockets.disconnectHost(hostId)
    });
    requestListener = (request: IncomingMessage, response: ServerResponse) => {
      const operation = (async () => {
        if (requiresAdmission(request) && readiness.readiness().status !== "ready") {
          request.resume();
          respond(response, 503, "server_not_accepting_mutations");
          return;
        }
        if (
          await handleHostEnrollmentRequest(request, response, {
            service: enrollments,
            allowInsecureDevelopment: config.allowInsecureDevelopment
          })
        ) {
          return;
        }
        if (
          await handleAgentHostArtifactRequest(request, response, {
            hosts: coordination.hosts,
            dispatches: coordination.dispatches,
            authorization: coordination.artifactAuthorization,
            artifacts: initializedArtifactStore,
            allowInsecureTransport: config.allowInsecureDevelopment
          })
        ) {
          return;
        }
        if (
          await handleHumanHttpRequest(request, response, {
            service: humanMembership,
            repository: humanIdentity,
            allowInsecureDevelopment: config.allowInsecureDevelopment,
            clock
          })
        ) {
          return;
        }
        if (
          await handleCommentAttachmentHttpRequest(request, response, {
            service: commentAttachments,
            repository: humanIdentity,
            allowInsecureDevelopment: config.allowInsecureDevelopment,
            clock
          })
        ) {
          return;
        }
        if (
          await handleOperatorHttpRequest(request, response, {
            authorization,
            service: control,
            readiness: () => readiness.readiness(),
            serverVersion: serverPackageVersion,
            limits: {
              maxArtifactBytes: config.limits.maxArtifactBytes,
              maxWebSocketPayloadBytes: config.limits.maxWebSocketPayloadBytes
            },
            allowInsecureDevelopment: config.allowInsecureDevelopment
          })
        ) {
          return;
        }
        respond(response, 404, "route_not_found");
      })().catch(() => respond(response, 500, "request_failed"));
      inflightRequests.add(operation);
      void operation.finally(() => inflightRequests.delete(operation));
    };
    options.httpServer.on("request", requestListener);
    const attachedRequestListener = requestListener;
    if (!options.readiness) readiness.transition("ready", schemaVersion);
    let closePromise: Promise<void> | undefined;
    const beginDrain = () => {
      if (readiness.readiness().status !== "draining") {
        readiness.transition("draining", schemaVersion);
      }
    };
    let drainPromise: Promise<void> | undefined;
    const drainTransports = () => {
      beginDrain();
      drainPromise ??= drainCompositionTransports({
        httpServer: options.httpServer,
        requestListener: attachedRequestListener,
        webSockets: attachedWebSockets,
        inflightRequests,
        shutdownTimeoutMs: config.limits.shutdownTimeoutMs
      });
      return drainPromise;
    };
    return {
      ownsHttpServer: false,
      readiness: () => readiness.readiness(),
      beginDrain,
      drainTransports,
      async close() {
        beginDrain();
        closePromise ??= (async () => {
          const errors: unknown[] = [];
          try {
            await drainTransports();
          } catch (error) {
            if (containsCleanupError(error, "server_http_inflight_drain_timeout")) {
              throw new AggregateError([error], "server_shutdown_requires_process_exit", {
                cause: error
              });
            }
            errors.push(error);
          }
          try {
            closeCompositionStorage({
              closeLifecycle: server.close,
              closeRuntimeRegistry: runtimeRegistry.close
            });
          } catch (error) {
            errors.push(error);
          }
          if (errors.length > 0) {
            throw new AggregateError(errors, "distributed_server_cleanup_failed");
          }
        })();
        return closePromise;
      }
    };
  } catch (error) {
    if (readiness.readiness().status !== "draining") readiness.transition("draining");
    const cleanupErrors: unknown[] = [];
    try {
      await drainCompositionTransports({
        httpServer: options.httpServer,
        requestListener,
        webSockets,
        inflightRequests,
        shutdownTimeoutMs: config.limits.shutdownTimeoutMs
      });
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    const requiresProcessExit = cleanupErrors.some((cleanupError) =>
      containsCleanupError(cleanupError, "server_http_inflight_drain_timeout")
    );
    if (!requiresProcessExit) {
      try {
        closeCompositionStorage({
          closeLifecycle: lifecycle?.server.close,
          closeRuntimeRegistry: runtimeRegistry.close
        });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "distributed_server_startup_and_cleanup_failed",
        { cause: error }
      );
    }
    throw error;
  }
}
