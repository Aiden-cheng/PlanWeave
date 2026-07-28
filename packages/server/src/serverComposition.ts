import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createRemoteBlockArtifactSource,
  createRemoteBlockRuntimePort,
  manifestSchema,
  resolveProjectCanvasWorkspace
} from "@planweave-ai/runtime";
import { canonicalRemoteRuntimePort } from "./canonicalRemoteRuntimePort.js";
import { ArtifactStore } from "./artifacts.js";
import { handleAgentHostArtifactRequest } from "./artifactHttp.js";
import {
  ActivityRepository,
  ActivityProjectionService,
  ActivityRetentionMaintenance,
  activitySubjectSchema,
  CommentRepository,
  CommentService,
  CommentServiceError,
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
  readAclRegistryMigration,
  repairAclRegistryMigration,
  retryAclRegistryMigration
} from "./migrations.js";
import {
  handleHumanHttpRequest,
  HumanIdentityRepository,
  HumanMembershipService,
  handleWorkspaceIdentityHttpRequest
} from "./identity/index.js";
import { handleSetupCodeHttpRequest } from "./identity/setupCodeHttp.js";
import { SetupCodeService } from "./identity/setupCodeService.js";
import { handleWorkspaceConnectionHttpRequest } from "./identity/workspaceConnectionHttp.js";
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
import { createManifestWorkItemPort } from "./work/workItemFacts.js";
import { ProjectAccessRepository } from "./projectAccessRepository.js";
import { handleAccessHttpRequest } from "./accessHttp.js";
import {
  createTrustedProjectControlPort,
  type TrustedProjectControlPort
} from "./trustedProjectControl.js";
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
import {
  attachCanvasCommandWebSocketServer,
  CanvasCommandRepository,
  CanvasCommandService,
  ContentVersionRepository,
  SqliteAuthoritativeCanvasCommitStore,
  ContentVersionService,
  createDefaultCanvasRuntimePort,
  handleCanvasCommandHttpRequest,
  handleContentVersionHttpRequest,
  type CanvasCommandWebSocketServer
} from "./canvas/index.js";
import { WebSocketUpgradeRouter } from "./webSocketUpgradeRouter.js";
import {
  createActiveDispatchResolver,
  createHostAssignmentPort,
  createIdentityMembershipPort,
  AuthorityRepository,
  AuthorityService,
  assertHumanScopeAuthorized,
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
  readonly trustedProjectControl: TrustedProjectControlPort;
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
  canvasCommandWebSockets?: CanvasCommandWebSocketServer;
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
  try {
    await input.canvasCommandWebSockets?.close();
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
    pathname === "/api/v1/setup-codes/redeem" ||
    (pathname.startsWith("/api/v1/workspaces/") && pathname.includes("/setup-codes")) ||
    pathname === "/api/v1/remote-operations" ||
    /^\/api\/v1\/remote-operations\/[^/]+\/actions$/.test(pathname) ||
    /^\/api\/v1\/remote-operations\/[^/]+\/interactions\/respond$/.test(pathname) ||
    /^\/api\/v1\/projects\/[^/]+\/human\//.test(pathname) ||
    /^\/api\/v1\/projects\/[^/]+\/assignments(\/|$)/.test(pathname) ||
    /^\/api\/v1\/projects\/[^/]+\/comments(\/|$)/.test(pathname) ||
    /^\/api\/v1\/projects\/[^/]+\/attachments(\/|$)/.test(pathname) ||
    /^\/api\/v1\/projects\/[^/]+\/canvases\/[^/]+\/content\/(initial-publish|acknowledgements)$/.test(
      pathname
    ) ||
    /^\/api\/v1\/registry\/projects\/[^/]+\/canvases\/[^/]+\/snapshots(\/|$)/.test(pathname)
  );
}

function prepareAclRegistryMigrationForStartup(input: {
  database: Parameters<typeof readAclRegistryMigration>[0];
  workspaceId: string;
  projectId: string;
  canvasId?: string;
  sourceKind: "trusted_project" | "trusted_canvas";
}): void {
  const scope = {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    ...(input.canvasId === undefined ? {} : { canvasId: input.canvasId }),
    sourceKind: input.sourceKind
  } as const;
  const migration = readAclRegistryMigration(input.database, scope);
  if (!migration || migration.status === "completed") return;
  if (migration.status === "interrupted" || migration.status === "repair_required") {
    repairAclRegistryMigration(input.database, scope);
  }
  retryAclRegistryMigration(input.database, scope);
}

function uniqueConfiguredWorkspaceId(input: {
  runtimeRegistry: Pick<Awaited<ReturnType<typeof createTrustedRuntimeRegistry>>, "expansions">;
  projectId: string;
  canvasId?: string;
}): string | undefined {
  const workspaceIds = [
    ...new Set(
      input.runtimeRegistry.expansions
        .filter(
          (scope) =>
            scope.projectId === input.projectId &&
            (input.canvasId === undefined || scope.canvasId === input.canvasId)
        )
        .map((scope) => scope.workspaceId)
    )
  ];
  return workspaceIds.length === 1 ? workspaceIds[0] : undefined;
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
  let canvasCommandWebSockets: CanvasCommandWebSocketServer | undefined;
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
    const setupCodes = new SetupCodeService({
      database: server.database,
      serverBaseUrl: config.publicUrl.endsWith("/") ? config.publicUrl : `${config.publicUrl}/`,
      allowInsecureTransport: config.allowInsecureDevelopment,
      clock,
      operatorSessionTtlMs: config.operatorSessionTtlMs,
      onWorkspaceDeviceMembershipCreated: ({ workspaceId, humanPrincipalId, role }) => {
        const projectIds = new Set<string>();
        for (const scope of runtimeRegistry.expansions) {
          if (scope.workspaceId !== workspaceId || projectIds.has(scope.projectId)) continue;
          projectIds.add(scope.projectId);
          projectAccess!.synchronizeHumanMembershipOwnerInCallerTransaction({
            workspaceId,
            projectId: scope.projectId,
            humanPrincipalId,
            transition: "member_joined",
            membershipRole: role
          });
        }
      }
    });
    const workspaceIdentity = new WorkspaceIdentityRepository(server.database);
    projectAccess = new ProjectAccessRepository(server.database, clock);
    runtimeRegistry.setScopedPackageResolver((input) => {
      if (!workspaceIdentity.workspaceExists(input.workspaceId)) return undefined;
      const canvas = projectAccess!.registry.canvasInternal(
        input.workspaceId,
        input.projectId,
        input.canvasId
      );
      if (!canvas || canvas.revokedAt !== null || !canvas.packageDir) return undefined;
      const manifest = manifestSchema.parse(
        JSON.parse(readFileSync(join(canvas.packageDir, "manifest.json"), "utf8"))
      );
      return createManifestWorkItemPort(manifest, input.canvasId);
    });
    runtimeRegistry.registry.setScopedResolver(async (locator) => {
      const workspaceId =
        locator.workspaceId ??
        uniqueConfiguredWorkspaceId({
          runtimeRegistry,
          projectId: locator.projectId,
          canvasId: locator.canvasId
        });
      if (!workspaceId || !workspaceIdentity.workspaceExists(workspaceId)) {
        throw new Error("remote_runtime_workspace_unresolved");
      }
      const project = projectAccess!.registry.projectInternal(workspaceId, locator.projectId);
      const canvas = projectAccess!.registry.canvasInternal(
        workspaceId,
        locator.projectId,
        locator.canvasId
      );
      if (
        !project ||
        project.revokedAt !== null ||
        !project.projectRoot ||
        !canvas ||
        canvas.revokedAt !== null ||
        !canvas.packageDir
      ) {
        throw new Error("remote_runtime_scope_unavailable");
      }
      const workspace = await resolveProjectCanvasWorkspace(project.projectRoot, locator.canvasId);
      if (resolve(workspace.packageDir) !== resolve(canvas.packageDir)) {
        throw new Error("remote_runtime_registry_path_mismatch");
      }
      return {
        runtime: canonicalRemoteRuntimePort(
          createRemoteBlockRuntimePort({ projectRoot: workspace }),
          workspaceId
        ),
        artifacts: createRemoteBlockArtifactSource({ projectRoot: workspace }),
        release() {}
      };
    });
    const canvasesByProjectScope = new Map<
      string,
      {
        workspaceId: string;
        projectId: string;
        projectRoot: string;
        canvases: typeof runtimeRegistry.expansions;
      }
    >();
    for (const expansion of runtimeRegistry.expansions) {
      const projectScopeKey = `${expansion.workspaceId}\0${expansion.projectId}`;
      const current = canvasesByProjectScope.get(projectScopeKey);
      if (current) {
        current.canvases = [...current.canvases, expansion];
      } else {
        canvasesByProjectScope.set(projectScopeKey, {
          workspaceId: expansion.workspaceId,
          projectId: expansion.projectId,
          projectRoot: expansion.projectRoot,
          canvases: [expansion]
        });
      }
    }
    for (const project of canvasesByProjectScope.values()) {
      const { workspaceId, projectId } = project;
      workspaceIdentity.ensureConfiguredWorkspace(workspaceId);
      prepareAclRegistryMigrationForStartup({
        database: server.database,
        workspaceId,
        projectId,
        sourceKind: "trusted_project"
      });
      const existingProject = projectAccess.registry.projectInternal(workspaceId, projectId);
      if (existingProject?.projectRoot === null)
        projectAccess.bindProjectPath(workspaceId, projectId, project.projectRoot);
      projectAccess.registerProjectInternal({
        workspaceId,
        projectId,
        projectRoot: project.projectRoot
      });
      for (const canvas of project.canvases) {
        prepareAclRegistryMigrationForStartup({
          database: server.database,
          workspaceId,
          projectId,
          canvasId: canvas.canvasId,
          sourceKind: "trusted_canvas"
        });
        projectAccess.registerCanvasInternal({
          workspaceId,
          projectId,
          canvasId: canvas.canvasId,
          packageDir: canvas.packageDir
        });
        projectAccess.markCanvasCutover(workspaceId, projectId, canvas.canvasId);
      }
      projectAccess.reconcileRuntimeCanvases(
        workspaceId,
        projectId,
        project.canvases.map((canvas) => canvas.canvasId)
      );
      projectAccess.finalizeProjectCutover(workspaceId, projectId);
    }
    for (const projectId of new Set(runtimeRegistry.expansions.map((scope) => scope.projectId))) {
      const workspaceId = uniqueConfiguredWorkspaceId({ runtimeRegistry, projectId });
      if (workspaceId) workspaceIdentity.ensureLegacyProjectAdapter(projectId, workspaceId);
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
      serverAdminAnchorWorkspaceId: runtimeRegistry.expansions[0]?.workspaceId,
      workspaceForProject: (projectId) => {
        const scopes = runtimeRegistry.expansions.filter(
          (expansion) => expansion.projectId === projectId
        );
        const workspaceIds = [...new Set(scopes.map((scope) => scope.workspaceId))];
        return workspaceIds.length === 1 ? workspaceIds[0] : undefined;
      },
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
    const collaborationScopeKey = (workspaceId: string, projectId: string) =>
      `${workspaceId}\u0000${projectId}`;
    for (const { workspaceId, projectId, canvasId } of runtimeRegistry.expansions) {
      const serviceKey = collaborationScopeKey(workspaceId, projectId);
      if (commentServices.has(serviceKey)) continue;
      const packagePort = runtimeRegistry.scopedWorkItemPackagePort({
        workspaceId,
        projectId,
        canvasId
      });
      if (!packagePort) throw new Error("trusted_project_work_item_port_missing");
      const scopedCommentRepository = new CommentRepository(server.database, workspaceId);
      const scopedActivityRepository = new ActivityRepository(server.database, { workspaceId });
      commentServices.set(
        serviceKey,
        new CommentService({
          comments: scopedCommentRepository,
          activity: scopedActivityRepository,
          packagePort,
          identity: humanIdentity,
          attachments: commentAttachments,
          attachmentRepository: commentAttachmentRepository,
          authorizeMutation(actor, workItem) {
            try {
              initializedProjectAccess.policy.assertCapability({
                workspaceId,
                projectId: actor.projectId,
                canvasId: workItem.canvasId,
                actor: { kind: "human", id: actor.humanPrincipalId },
                capability: "comment"
              });
            } catch {
              throw new CommentServiceError("comment_auth_forbidden");
            }
          },
          assertMembership(actor) {
            const membership = workspaceIdentity
              .listMembershipViews(workspaceId)
              .find(
                (candidate) =>
                  candidate.humanPrincipalId === actor.humanPrincipalId &&
                  candidate.revokedAt === null
              );
            if (!membership || membership.role !== actor.role) {
              throw new CommentServiceError("comment_auth_forbidden");
            }
          },
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
    const authorityRepository = new AuthorityRepository(server.database, { clock });
    const initializedProjectAccess = projectAccess;
    const acquireAuthorityService = (workspaceId: string, projectId: string, canvasId: string) => {
      if (!workspaceIdentity.workspaceExists(workspaceId)) return undefined;
      const project = initializedProjectAccess.registry.projectInternal(workspaceId, projectId);
      const canvas = initializedProjectAccess.registry.canvasInternal(
        workspaceId,
        projectId,
        canvasId
      );
      if (!project || project.revokedAt !== null || !canvas || canvas.revokedAt !== null)
        return undefined;
      const acquired = runtimeRegistry.acquireScopedWorkItemPackagePort({
        workspaceId,
        projectId,
        canvasId
      });
      if (!acquired) return undefined;
      const service = new AuthorityService({
        repository: authorityRepository,
        packagePort: acquired.port,
        access: initializedProjectAccess,
        workspaceIdentity,
        hosts: coordination.hosts,
        clock
      });
      return { service, release: acquired.release };
    };
    for (const { projectId, canvasId } of runtimeRegistry.locators) {
      if (assignmentServices.has(projectId)) continue;
      const workspaceId = uniqueConfiguredWorkspaceId({ runtimeRegistry, projectId, canvasId });
      if (!workspaceId) continue;
      const packagePort = runtimeRegistry.scopedWorkItemPackagePort({
        workspaceId,
        projectId,
        canvasId
      });
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
      workspaceIdentity,
      projectAuthority: runtimeRegistry,
      maxPayloadBytes: config.limits.maxWebSocketPayloadBytes,
      shutdownTimeoutMs: config.limits.shutdownTimeoutMs,
      allowInsecureTransport: config.allowInsecureDevelopment,
      clock
    });
    const canvasCommandRepository = new CanvasCommandRepository(server.database, { clock });
    const contentVersionRepository = new ContentVersionRepository(server.database, clock);
    const authoritativeCanvasCommits = new SqliteAuthoritativeCanvasCommitStore(
      server.database,
      contentVersionRepository,
      canvasCommandRepository
    );
    const contentVersionService = new ContentVersionService({
      repository: contentVersionRepository,
      access: initializedProjectAccess,
      workspaceIdentity
    });
    const canvasCommandService = new CanvasCommandService({
      repository: canvasCommandRepository,
      access: initializedProjectAccess,
      workspaceIdentity,
      runtime: createDefaultCanvasRuntimePort(),
      contentVersions: contentVersionRepository,
      authoritativeCommits: authoritativeCanvasCommits,
      clock
    });
    await canvasCommandService.recoverInterrupted();
    canvasCommandWebSockets = attachCanvasCommandWebSocketServer({
      upgradeRouter,
      service: canvasCommandService,
      repository: humanIdentity,
      workspaceIdentity,
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
      interactions: coordination.interactions,
      authorizeCanvas: (context, scope) => {
        const workspaceId =
          "kind" in context && context.kind === "workspace_device"
            ? context.workspaceId
            : workspaceIdentity.workspaceForLegacyProject(scope.projectId);
        if (!workspaceId) throw new Error("authority_workspace_mismatch");
        assertHumanScopeAuthorized({
          actor: context,
          scope: { workspaceId, ...scope },
          access: initializedProjectAccess,
          workspaceIdentity
        });
      }
    });
    requestListener = (request: IncomingMessage, response: ServerResponse) => {
      const operation = (async () => {
        if (requiresAdmission(request) && readiness.readiness().status !== "ready") {
          request.resume();
          respond(response, 503, "server_not_accepting_mutations");
          return;
        }
        if (
          await handleWorkspaceConnectionHttpRequest(request, response, {
            workspaceIdentity,
            allowInsecureDevelopment: config.allowInsecureDevelopment
          })
        ) {
          return;
        }
        if (
          await handleAccessHttpRequest(request, response, {
            access: initializedProjectAccess,
            repository: humanIdentity,
            workspaceIdentity,
            projectAuthority: runtimeRegistry,
            allowInsecureDevelopment: config.allowInsecureDevelopment
          })
        ) {
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
            workspaceIdentity,
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
            acquireAuthorityService,
            repository: humanIdentity,
            workspaceIdentity,
            access: initializedProjectAccess,
            projectAuthority: runtimeRegistry,
            allowInsecureDevelopment: config.allowInsecureDevelopment,
            clock
          })
        ) {
          return;
        }
        if (
          await handleContentVersionHttpRequest(request, response, {
            service: contentVersionService,
            repository: humanIdentity,
            workspaceIdentity,
            projectAuthority: runtimeRegistry,
            allowInsecureDevelopment: config.allowInsecureDevelopment
          })
        ) {
          return;
        }
        if (
          await handleCanvasCommandHttpRequest(request, response, {
            service: canvasCommandService,
            repository: humanIdentity,
            workspaceIdentity,
            projectAuthority: runtimeRegistry,
            allowInsecureDevelopment: config.allowInsecureDevelopment,
            clock
          })
        ) {
          return;
        }
        if (
          await handleCommentActivityHttpRequest(request, response, {
            resolveService: (workspaceId, projectId) =>
              commentServices.get(collaborationScopeKey(workspaceId, projectId)),
            repository: humanIdentity,
            workspaceIdentity,
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
          await handleSetupCodeHttpRequest(request, response, {
            service: setupCodes,
            authorization,
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
        canvasCommandWebSockets,
        upgradeRouter,
        inflightRequests,
        shutdownTimeoutMs: config.limits.shutdownTimeoutMs
      });
      return drainPromise;
    };
    return {
      ownsHttpServer: false,
      trustedProjectControl: createTrustedProjectControlPort({
        runtimeRegistry,
        projectAccess: initializedProjectAccess
      }),
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
        canvasCommandWebSockets,
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
