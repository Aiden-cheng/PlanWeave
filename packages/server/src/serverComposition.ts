import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { ArtifactStore } from "./artifacts.js";
import { handleAgentHostArtifactRequest } from "./artifactHttp.js";
import {
  ActivityRepository,
  ActivityProjectionService,
  ActivityRetentionMaintenance,
  activitySubjectSchema,
  CommentRepository,
  CommentService,
  handleCommentActivityHttpRequest
} from "./comments/index.js";
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
  HumanMembershipService,
  handleWorkspaceIdentityHttpRequest
} from "./identity/index.js";
import { WorkspaceIdentityRepository } from "./identity/workspaceRepository.js";
import { provisionConfiguredOperatorSessions } from "./identity/operatorSessionProvisioning.js";
import { OperatorTokenRegistry } from "./operatorAuth.js";
import { handleOperatorHttpRequest } from "./operatorHttp.js";
import { handleRegistryHttpRequest, type RegistryHttpService } from "./registryHttp.js";
import { serverPackageVersion } from "./packageInfo.js";
import { ServerReadinessController, type ServerReadiness } from "./readiness.js";
import { RemoteControlService } from "./remoteControlService.js";
import { HumanRemoteControlService } from "./humanRemoteControlService.js";
import { handleHumanRemoteHttpRequest } from "./humanRemoteHttp.js";
import { observerEventsForActivity } from "./humanObserverActivity.js";
import { HumanObserverJournal } from "./humanObserverJournal.js";
import {
  ArtifactStoreRemoteContent,
  RuntimeInputArtifactMaterializer
} from "./runtimeArtifactAdapter.js";
import { createTrustedRuntimeRegistry } from "./runtimeProjectRegistry.js";
import { ProjectAccessRepository } from "./projectAccessRepository.js";
import { PackageSnapshotRepository } from "./packageSnapshotRepository.js";
import { attachAgentHostWebSocketServer, type AgentHostWebSocketServer } from "./wsServer.js";
import {
  attachHumanObserverWebSocketServer,
  type HumanObserverWebSocketServer
} from "./humanObserverWs.js";
import {
  attachCanvasPresenceWebSocketServer,
  type CanvasPresenceWebSocketServer
} from "./presenceWebSocket.js";
import { WebSocketUpgradeRouter } from "./webSocketUpgradeRouter.js";
import {
  createActiveDispatchResolver,
  createHostAssignmentPort,
  createIdentityMembershipPort,
  handleWorkAssignmentHttpRequest,
  WorkAssignmentService
} from "./work/index.js";

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
  humanObserverWebSockets?: HumanObserverWebSocketServer;
  canvasPresenceWebSockets?: CanvasPresenceWebSocketServer;
  upgradeRouter?: WebSocketUpgradeRouter;
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
    await input.humanObserverWebSockets?.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await input.canvasPresenceWebSockets?.close();
  } catch (error) {
    errors.push(error);
  }
  input.upgradeRouter?.close();
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
  if (request.method !== "POST" && request.method !== "PATCH") return false;
  const pathname = new URL(request.url ?? "/", "http://planweave.invalid").pathname;
  return (
    pathname === "/agent-hosts/enrollments/exchange" ||
    pathname === "/api/v1/host-enrollments" ||
    pathname === "/api/v1/remote-operations" ||
    /^\/api\/v1\/remote-operations\/[^/]+\/actions$/.test(pathname) ||
    /^\/api\/v1\/remote-operations\/[^/]+\/interactions\/respond$/.test(pathname) ||
    /^\/api\/v1\/projects\/[^/]+\/human\//.test(pathname) ||
    /^\/api\/v1\/projects\/[^/]+\/assignments(\/|$)/.test(pathname) ||
    /^\/api\/v1\/projects\/[^/]+\/comments(\/|$)/.test(pathname) ||
    /^\/api\/v1\/projects\/[^/]+\/attachments(\/|$)/.test(pathname) ||
    /^\/api\/v1\/registry\/projects\/[^/]+\/canvases\/[^/]+\/snapshots(\/|$)/.test(pathname)
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
  let activityRepository: ActivityRepository | undefined;
  let activityProjection: ActivityProjectionService | undefined;
  let activityRetention: ActivityRetentionMaintenance | undefined;
  let webSockets: AgentHostWebSocketServer | undefined;
  let humanObserverWebSockets: HumanObserverWebSocketServer | undefined;
  let canvasPresenceWebSockets: CanvasPresenceWebSocketServer | undefined;
  let upgradeRouter: WebSocketUpgradeRouter | undefined;
  let requestListener: ((request: IncomingMessage, response: ServerResponse) => void) | undefined;
  let humanIdentityForInteractions: HumanIdentityRepository | undefined;
  let humanObserverJournal: HumanObserverJournal | undefined;
  let projectAccess: ProjectAccessRepository | undefined;
  let packageSnapshots: PackageSnapshotRepository | undefined;
  const inflightRequests = new Set<Promise<void>>();
  try {
    let authorization: OperatorTokenRegistry;
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
        const observerJournal = new HumanObserverJournal(
          database,
          config.limits.eventRetentionMaxEvents,
          clock
        );
        humanObserverJournal = observerJournal;
        const projectionRepository = new ActivityRepository(database, {
          onInsertedInTransaction: (record) => {
            for (const event of observerEventsForActivity(record)) {
              observerJournal.appendInCallerTransaction(record.projectId, event, record.occurredAt);
            }
          }
        });
        const projection = new ActivityProjectionService({
          activity: projectionRepository,
          clock
        });
        activityRepository = projectionRepository;
        activityProjection = projection;
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
          interactionAuthorization: {
            canRespond: (input) => {
              if (authorization.canRespond(input)) return true;
              if (!humanIdentityForInteractions) {
                throw new Error("human_identity_not_initialized");
              }
              return (
                humanIdentityForInteractions.getActiveMembership(
                  input.projectId,
                  input.responderId
                ) !== undefined
              );
            }
          },
          eventRetentionMaxEvents: config.limits.eventRetentionMaxEvents,
          eventRetentionMaxBytes: config.limits.eventRetentionMaxBytes,
          onAssignmentUpdatedInTransaction: (record) => {
            const actor = activitySubjectSchema.parse(
              record.updatedBy.kind === "human"
                ? {
                    kind: "human" as const,
                    humanPrincipalId: record.updatedBy.id,
                    ...(record.updatedBy.displayName
                      ? { displayName: record.updatedBy.displayName }
                      : {})
                  }
                : record.updatedBy.kind === "local_admin"
                  ? {
                      kind: "local_admin" as const,
                      humanPrincipalId: record.updatedBy.id,
                      ...(record.updatedBy.displayName
                        ? { displayName: record.updatedBy.displayName }
                        : {})
                    }
                  : { kind: "system" as const }
            );
            const targetHeadline =
              record.target.kind === "unassigned"
                ? "Assignment cleared"
                : record.target.kind === "human"
                  ? "Assigned work item to a project member"
                  : record.target.kind === "exact_host"
                    ? "Assigned work item to an Agent Host"
                    : "Assigned work item to automatic Host selection";
            projection.projectAssignmentEventInCallerTransaction({
              projectId: record.projectId,
              workItem: record.workItem,
              assignmentRevision: record.revision,
              actor,
              targetHeadline,
              occurredAt: record.updatedAt
            });
          },
          onDispatchActivityTransitionInTransaction: (input) => {
            projection.projectRemoteRunEventInCallerTransaction({
              projectId: input.dispatch.projectId,
              type: input.type,
              dispatchId: input.dispatch.id,
              hostId: input.dispatch.hostId,
              occurredAt: input.occurredAt
            });
          }
        };
      }
    );
    if (!artifactStore) throw new Error("artifact_store_not_initialized");
    if (!activityRepository || !activityProjection) {
      throw new Error("activity_projection_not_initialized");
    }
    if (!humanObserverJournal) throw new Error("human_observer_journal_not_initialized");
    const initializedArtifactStore = artifactStore;
    const initializedActivityRepository = activityRepository;
    const initializedActivityProjection = activityProjection;
    const initializedHumanObserverJournal = humanObserverJournal;
    const { coordination, server } = lifecycle;
    const schemaVersion = server.readiness().schemaVersion;
    readiness.transition("reconciling", schemaVersion);
    const enrollments = new HostEnrollmentService(server.database, clock);
    const workspaceIdentity = new WorkspaceIdentityRepository(server.database);
    projectAccess = new ProjectAccessRepository(server.database, clock);
    const canvasesByProject = new Map<
      string,
      { projectRoot: string; canvases: typeof runtimeRegistry.expansions }
    >();
    for (const expansion of runtimeRegistry.expansions) {
      const current = canvasesByProject.get(expansion.projectId);
      if (current) {
        current.canvases = [...current.canvases, expansion];
      } else {
        canvasesByProject.set(expansion.projectId, {
          projectRoot: expansion.projectRoot,
          canvases: [expansion]
        });
      }
    }
    for (const [projectId, project] of canvasesByProject) {
      const workspaceId = workspaceIdentity.ensureWorkspaceForLegacyProject(projectId);
      const existingProject = projectAccess.registry.projectInternal(workspaceId, projectId);
      if (existingProject?.projectRoot === null)
        projectAccess.bindProjectPath(workspaceId, projectId, project.projectRoot);
      projectAccess.registerProjectInternal({
        workspaceId,
        projectId,
        projectRoot: project.projectRoot
      });
      for (const canvas of project.canvases) {
        projectAccess.registerCanvasInternal({
          workspaceId,
          projectId,
          canvasId: canvas.canvasId,
          packageDir: canvas.packageDir
        });
        projectAccess.markCanvasCutover(workspaceId, projectId, canvas.canvasId);
      }
      projectAccess.finalizeProjectCutover(workspaceId, projectId);
    }
    packageSnapshots = new PackageSnapshotRepository(
      server.database,
      projectAccess,
      config.dataDirectory,
      clock
    );
    if (!projectAccess || !packageSnapshots)
      throw new Error("project_access_services_not_initialized");
    const registryService: RegistryHttpService = {
      listProjects(input) {
        const items = projectAccess!.listAuthorizedProjects({
          workspaceId: input.workspaceId,
          actor: input.actor,
          limit: input.limit,
          offset: input.cursor
        });
        return {
          items,
          nextCursor: items.length === input.limit ? input.cursor + input.limit : null
        };
      },
      listCanvases(input) {
        const items = projectAccess!.listAuthorizedCanvases({
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          actor: input.actor,
          limit: input.limit,
          offset: input.cursor
        });
        return {
          items,
          nextCursor: items.length === input.limit ? input.cursor + input.limit : null
        };
      },
      readSnapshot(input) {
        return packageSnapshots!.read(input);
      },
      createSnapshot(input) {
        return packageSnapshots!.create(input);
      },
      restoreSnapshot(input) {
        return packageSnapshots!.restore(input);
      }
    };
    authorization = new OperatorTokenRegistry(server.database, config.operatorCredentials, clock);
    provisionConfiguredOperatorSessions({
      database: server.database,
      credentials: config.operatorCredentials,
      trustedProjectIds: [...new Set(runtimeRegistry.expansions.map((canvas) => canvas.projectId))],
      workspaceForProject: (projectId) => workspaceIdentity.workspaceForLegacyProject(projectId),
      operatorSessionTtlMs: config.operatorSessionTtlMs,
      clock
    });
    const humanIdentity = new HumanIdentityRepository(server.database, clock, {
      onMembershipTransitionInTransaction: ({ type, membership, principal }) => {
        const workspaceId = workspaceIdentity.workspaceForLegacyProject(membership.projectId);
        if (!workspaceId) throw new Error("workspace_not_found");
        projectAccess!.synchronizeHumanMembershipOwnerInCallerTransaction({
          workspaceId,
          projectId: membership.projectId,
          humanPrincipalId: principal.humanPrincipalId,
          transition: type,
          membershipRole: membership.role
        });
        initializedActivityProjection.projectMembershipEventInCallerTransaction({
          projectId: membership.projectId,
          type,
          membershipId: membership.membershipId,
          transitionRevision: membership.revision,
          humanPrincipalId: membership.humanPrincipalId,
          displayName: principal.displayName,
          membershipRole: membership.role,
          occurredAt: membership.updatedAt
        });
      },
      onInvitationTransitionInTransaction: ({ invitation }) => {
        initializedHumanObserverJournal.appendInCallerTransaction(
          invitation.projectId,
          { kind: "invitation" },
          invitation.consumedAt ?? invitation.revokedAt ?? invitation.createdAt
        );
      }
    });
    humanIdentityForInteractions = humanIdentity;
    const humanMembership = new HumanMembershipService({
      repository: humanIdentity,
      projectAuthority: runtimeRegistry,
      clock
    });
    const commentAttachmentRepository = new CommentAttachmentRepository(server.database, {
      onMutationInTransaction: (input) => {
        initializedHumanObserverJournal.appendInCallerTransaction(
          input.projectId,
          {
            kind: "attachment",
            ...(input.commentId ? { commentId: input.commentId } : {})
          },
          input.occurredAt
        );
      }
    });
    const commentRepository = new CommentRepository(server.database);
    const commentAttachmentBlobs = new CommentAttachmentBlobStore(
      server.database,
      config.dataDirectory
    );
    const commentAttachments = new CommentAttachmentService({
      repository: commentAttachmentRepository,
      blobs: commentAttachmentBlobs,
      clock
    });
    const commentServices = new Map<string, CommentService>();
    for (const { projectId } of runtimeRegistry.locators) {
      if (commentServices.has(projectId)) continue;
      const packagePort = runtimeRegistry.workItemPackagePort(projectId);
      if (!packagePort) throw new Error("trusted_project_work_item_port_missing");
      commentServices.set(
        projectId,
        new CommentService({
          comments: commentRepository,
          activity: initializedActivityRepository,
          packagePort,
          identity: humanIdentity,
          attachments: commentAttachments,
          attachmentRepository: commentAttachmentRepository,
          clock
        })
      );
    }
    activityRetention = new ActivityRetentionMaintenance(initializedActivityRepository, clock);
    await activityRetention.start();
    const membershipPort = createIdentityMembershipPort({ identity: humanIdentity });
    const hostPort = createHostAssignmentPort({
      hosts: coordination.hosts,
      hostOfflineAfterMs: config.limits.hostOfflineAfterMs,
      clock
    });
    const activeDispatch = createActiveDispatchResolver(server.database);
    const assignmentServices = new Map<string, WorkAssignmentService>();
    for (const { projectId } of runtimeRegistry.locators) {
      if (assignmentServices.has(projectId)) continue;
      const packagePort = runtimeRegistry.workItemPackagePort(projectId);
      if (!packagePort) throw new Error("trusted_project_work_item_port_missing");
      assignmentServices.set(
        projectId,
        new WorkAssignmentService({
          repository: coordination.workAssignments,
          packagePort,
          membershipPort,
          hostPort,
          resolveActiveDispatch: activeDispatch,
          clock
        })
      );
    }
    upgradeRouter = new WebSocketUpgradeRouter(options.httpServer);
    webSockets = attachAgentHostWebSocketServer({
      server: options.httpServer,
      upgradeRouter,
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
    humanObserverWebSockets = attachHumanObserverWebSocketServer({
      upgradeRouter,
      journal: initializedHumanObserverJournal,
      repository: humanIdentity,
      projectAuthority: runtimeRegistry,
      maxPayloadBytes: config.limits.maxWebSocketPayloadBytes,
      shutdownTimeoutMs: config.limits.shutdownTimeoutMs,
      allowInsecureTransport: config.allowInsecureDevelopment,
      clock
    });
    canvasPresenceWebSockets = attachCanvasPresenceWebSocketServer({
      upgradeRouter,
      repository: humanIdentity,
      projectAuthority: runtimeRegistry,
      maxPayloadBytes: config.limits.maxWebSocketPayloadBytes,
      shutdownTimeoutMs: config.limits.shutdownTimeoutMs,
      allowInsecureTransport: config.allowInsecureDevelopment,
      clock
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
      disconnectHost: (hostId) => attachedWebSockets.disconnectHost(hostId),
      workspaceIdentity,
      hostOfflineAfterMs: config.limits.hostOfflineAfterMs,
      clock
    });
    const humanRemoteControl = new HumanRemoteControlService({
      operations: coordination.operations,
      dispatches: coordination.dispatches,
      coordinator: coordination.coordinator,
      events: coordination.acpEvents,
      interactions: coordination.interactions
    });
    requestListener = (request: IncomingMessage, response: ServerResponse) => {
      const operation = (async () => {
        if (requiresAdmission(request) && readiness.readiness().status !== "ready") {
          request.resume();
          respond(response, 503, "server_not_accepting_mutations");
          return;
        }
        if (
          await handleRegistryHttpRequest(request, response, {
            repository: humanIdentity,
            workspaceIdentity,
            service: registryService,
            readiness: () => readiness.readiness(),
            allowInsecureDevelopment: config.allowInsecureDevelopment
          })
        ) {
          return;
        }
        if (
          await handleHumanRemoteHttpRequest(request, response, {
            service: humanRemoteControl,
            repository: humanIdentity,
            projectAuthority: runtimeRegistry,
            readiness: () => readiness.readiness(),
            allowInsecureDevelopment: config.allowInsecureDevelopment
          })
        ) {
          return;
        }
        if (
          await handleWorkAssignmentHttpRequest(request, response, {
            resolveService: (projectId) => assignmentServices.get(projectId),
            repository: humanIdentity,
            projectAuthority: runtimeRegistry,
            allowInsecureDevelopment: config.allowInsecureDevelopment,
            clock
          })
        ) {
          return;
        }
        if (
          await handleCommentActivityHttpRequest(request, response, {
            resolveService: (projectId) => commentServices.get(projectId),
            repository: humanIdentity,
            projectAuthority: runtimeRegistry,
            allowInsecureDevelopment: config.allowInsecureDevelopment,
            clock
          })
        ) {
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
            projectAuthority: runtimeRegistry,
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
            projectAuthority: runtimeRegistry,
            allowInsecureDevelopment: config.allowInsecureDevelopment,
            clock
          })
        ) {
          return;
        }
        if (
          await handleWorkspaceIdentityHttpRequest(request, response, {
            authorization,
            repository: workspaceIdentity,
            allowInsecureDevelopment: config.allowInsecureDevelopment
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
        humanObserverWebSockets,
        canvasPresenceWebSockets,
        upgradeRouter,
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
            await activityRetention?.close();
          } catch (error) {
            errors.push(error);
          }
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
      await activityRetention?.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await drainCompositionTransports({
        httpServer: options.httpServer,
        requestListener,
        webSockets,
        humanObserverWebSockets,
        canvasPresenceWebSockets,
        upgradeRouter,
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
