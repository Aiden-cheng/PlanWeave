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
import {
  ActivityRepository,
  ActivityProjectionService,
  ActivityRetentionMaintenance,
  activitySubjectSchema,
  type ActivityRecord,
  CommentRepository,
  CommentService,
  CommentServiceError
} from "./comments/index.js";
import {
  CommentAttachmentBlobStore,
  CommentAttachmentRepository,
  CommentAttachmentService
} from "./attachments/index.js";
import { serverConfigSchema, type ServerConfig } from "./config.js";
import { startRemoteBlockCoordinationServer } from "./distributedCoordination.js";
import { HostEnrollmentService } from "./hostEnrollment.js";
import {
  readAclRegistryMigration,
  repairAclRegistryMigration,
  retryAclRegistryMigration
} from "./migrations.js";
import { HumanIdentityRepository, HumanMembershipService } from "./identity/index.js";
import { SetupCodeService } from "./identity/setupCodeService.js";
import { WorkspaceIdentityRepository } from "./identity/workspaceRepository.js";
import { provisionConfiguredOperatorSessions } from "./identity/operatorSessionProvisioning.js";
import { OperatorTokenRegistry } from "./operatorAuth.js";
import type { RegistryHttpService } from "./registryHttp.js";
import { serverPackageVersion } from "./packageInfo.js";
import { ServerReadinessController, type ServerReadiness } from "./readiness.js";
import { RemoteControlService } from "./remoteControlService.js";
import { RemoteCoordinationMaintenance } from "./remoteCoordinationMaintenance.js";
import { HumanRemoteControlService } from "./humanRemoteControlService.js";
import { observerEventsForActivity } from "./humanObserverActivity.js";
import { HumanObserverJournal } from "./humanObserverJournal.js";
import {
  ArtifactStoreRemoteContent,
  RuntimeInputArtifactMaterializer
} from "./runtimeArtifactAdapter.js";
import { createTrustedRuntimeRegistry } from "./runtimeProjectRegistry.js";
import { createManifestWorkItemPort } from "./work/workItemFacts.js";
import { ProjectAccessRepository } from "./projectAccessRepository.js";
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
import type { CanvasPresenceWebSocketServer } from "./presenceWebSocket.js";
import {
  type CanvasCommandWebSocketServer,
  type CanvasLiveSyncWebSocketServer
} from "./canvas/index.js";
import { createCanvasCollaborationComposition } from "./canvas/collaborationComposition.js";
import { WebSocketUpgradeRouter } from "./webSocketUpgradeRouter.js";
import { createTransportAdmissionPolicy } from "./insecureTransport.js";
import {
  createActiveDispatchResolver,
  createHostAssignmentPort,
  createIdentityMembershipPort,
  AuthorityRepository,
  AuthorityService,
  assertHumanScopeAuthorized,
  WorkAssignmentService
} from "./work/index.js";
import { SqliteExposureLeaseStore } from "./exposure/exposureLeaseRepository.js";
import { attachReverseProxyWebSocketReadiness } from "./exposure/reverseProxyWebSocketReadiness.js";
import type { ExposureLeaseStorePort } from "./exposure/types.js";
import { createDistributedHttpRequestListener } from "./distributedHttpRequestListener.js";
import {
  closeCompositionStorage,
  containsCleanupError,
  drainCompositionTransports
} from "./distributedCompositionLifecycle.js";

export type DistributedServerCompositionOptions = {
  httpServer: HttpServer;
  config: ServerConfig;
  /** Owner control-plane runtime scopes. They never widen collaboration HTTP/WS authority. */
  ownerTrustedProjects?: ServerConfig["trustedProjects"];
  clock?: () => Date;
  readiness?: ServerReadinessController;
};

export type DistributedServerComposition = {
  readonly ownsHttpServer: false;
  readonly trustedProjectControl: TrustedProjectControlPort;
  readonly exposureLeaseStore: ExposureLeaseStorePort;
  readiness(): ServerReadiness;
  beginDrain(): void;
  drainTransports(): Promise<void>;
  close(): Promise<void>;
};

function appendHumanObserverActivity(
  journal: HumanObserverJournal,
  workspaceId: string | undefined,
  record: ActivityRecord
): void {
  if (!workspaceId) throw new Error("human_observer_workspace_scope_unresolved");
  for (const event of observerEventsForActivity(record)) {
    journal.appendInCallerTransaction(
      { workspaceId, projectId: record.projectId },
      event,
      record.occurredAt
    );
  }
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

function assignmentServiceKey(workspaceId: string, projectId: string): string {
  return JSON.stringify([workspaceId, projectId]);
}

export async function createDistributedServerComposition(
  options: DistributedServerCompositionOptions
): Promise<DistributedServerComposition> {
  const config = serverConfigSchema.parse(options.config);
  if (config.trustedProjects.length === 0 && !options.ownerTrustedProjects?.length) {
    throw new Error("server_runtime_project_required");
  }
  const transportAdmission = createTransportAdmissionPolicy(config);
  const clock = options.clock ?? (() => new Date());
  const readiness = options.readiness ?? new ServerReadinessController();
  const runtimeRegistry = await createTrustedRuntimeRegistry(config.trustedProjects);
  let ownerRuntimeRegistry = runtimeRegistry;
  try {
    if (options.ownerTrustedProjects) {
      ownerRuntimeRegistry = await createTrustedRuntimeRegistry(options.ownerTrustedProjects);
    }
  } catch (error) {
    runtimeRegistry.close();
    throw error;
  }
  const closeRuntimeRegistries = () => {
    const errors: unknown[] = [];
    if (ownerRuntimeRegistry !== runtimeRegistry) {
      try {
        ownerRuntimeRegistry.close();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      runtimeRegistry.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, "runtime_registry_cleanup_failed");
  };
  let lifecycle: Awaited<ReturnType<typeof startRemoteBlockCoordinationServer>> | undefined;
  let artifactStore: ArtifactStore | undefined;
  let activityRepository: ActivityRepository | undefined;
  let activityProjection: ActivityProjectionService | undefined;
  let activityRetention: ActivityRetentionMaintenance | undefined;
  let remoteCoordinationMaintenance: RemoteCoordinationMaintenance | undefined;
  let webSockets: AgentHostWebSocketServer | undefined;
  let humanObserverWebSockets: HumanObserverWebSocketServer | undefined;
  let canvasPresenceWebSockets: CanvasPresenceWebSocketServer | undefined;
  let canvasCommandWebSockets: CanvasCommandWebSocketServer | undefined;
  let canvasLiveSyncWebSockets: CanvasLiveSyncWebSocketServer | undefined;
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
          onInsertedInTransaction: (record) =>
            appendHumanObserverActivity(
              observerJournal,
              new WorkspaceIdentityRepository(database).workspaceForLegacyProject(record.projectId),
              record
            )
        });
        const projection = new ActivityProjectionService({
          activity: projectionRepository,
          clock
        });
        const assignmentActivityProjections = new Map<string, ActivityProjectionService>();
        const assignmentActivityProjection = (workspaceId: string) => {
          let scoped = assignmentActivityProjections.get(workspaceId);
          if (!scoped) {
            scoped = new ActivityProjectionService({
              activity: new ActivityRepository(database, {
                workspaceId,
                onInsertedInTransaction: (record) =>
                  appendHumanObserverActivity(observerJournal, workspaceId, record)
              }),
              clock
            });
            assignmentActivityProjections.set(workspaceId, scoped);
          }
          return scoped;
        };
        activityRepository = projectionRepository;
        activityProjection = projection;
        return {
          leaseDurationMs: config.limits.leaseDurationMs,
          hostOfflineAfterMs: config.limits.hostOfflineAfterMs,
          clock,
          runtimeResolver: ownerRuntimeRegistry.registry,
          inputArtifacts: new RuntimeInputArtifactMaterializer(
            ownerRuntimeRegistry.registry,
            artifactStore
          ),
          artifactContent: new ArtifactStoreRemoteContent(artifactStore),
          ownerEndpointScopeAuthorized: (scope) => ownerRuntimeRegistry.hasScope(scope),
          interactionAuthorization: {
            canRespond: (input) => {
              if (authorization.canRespond(input)) return true;
              if (!humanIdentityForInteractions) {
                throw new Error("human_identity_not_initialized");
              }
              return workspaceIdentity
                .listMembershipViews(input.workspaceId)
                .some(
                  (membership) =>
                    membership.humanPrincipalId === input.responderId &&
                    membership.revokedAt === null
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
            assignmentActivityProjection(
              record.workspaceId
            ).projectAssignmentEventInCallerTransaction({
              projectId: record.projectId,
              workItem: record.workItem,
              assignmentRevision: record.revision,
              actor,
              targetHeadline,
              occurredAt: record.updatedAt
            });
          },
          onDispatchActivityTransitionInTransaction: (input) => {
            assignmentActivityProjection(
              input.dispatch.workspaceId
            ).projectRemoteRunEventInCallerTransaction({
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
    const enrollments = new HostEnrollmentService(server.database, clock, (hostId) =>
      webSockets?.disconnectHost(hostId)
    );
    const setupCodes = new SetupCodeService({
      database: server.database,
      serverBaseUrl: config.transport.advertisedOrigin.endsWith("/")
        ? config.transport.advertisedOrigin
        : `${config.transport.advertisedOrigin}/`,
      allowInsecureTransport: config.insecurePolicy.allowInsecureTransport,
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
    for (const workspaceId of new Set(
      ownerRuntimeRegistry.expansions.map((scope) => scope.workspaceId)
    )) {
      workspaceIdentity.ensureConfiguredWorkspace(workspaceId);
    }
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
      const workspaceId = locator.workspaceId;
      if (!workspaceIdentity.workspaceExists(workspaceId)) {
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
        projectRoot: project.projectRoot,
        visibility: existingProject?.visibility ?? "private"
      });
      for (const canvas of project.canvases) {
        prepareAclRegistryMigrationForStartup({
          database: server.database,
          workspaceId,
          projectId,
          canvasId: canvas.canvasId,
          sourceKind: "trusted_canvas"
        });
        const existingCanvas = projectAccess.registry.canvasInternal(
          workspaceId,
          projectId,
          canvas.canvasId
        );
        projectAccess.registerCanvasInternal({
          workspaceId,
          projectId,
          canvasId: canvas.canvasId,
          packageDir: canvas.packageDir,
          visibility: existingCanvas?.visibility ?? "private"
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
    const assertCollaborationCanvasScope = (input: {
      workspaceId: string;
      projectId: string;
      canvasId: string;
    }) => {
      if (!runtimeRegistry.hasScope(input)) throw new Error("registry_canvas_not_found");
    };
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
        const authorized: ReturnType<ProjectAccessRepository["listAuthorizedCanvases"]> = [];
        const pageSize = 100;
        for (let offset = 0; ; offset += pageSize) {
          const page = projectAccess!.listAuthorizedCanvases({
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            actor: input.actor,
            limit: pageSize,
            offset
          });
          authorized.push(...page);
          if (page.length < pageSize) break;
        }
        const visible = authorized.filter((canvas) =>
          runtimeRegistry.hasScope({
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            canvasId: canvas.registry.canvasId
          })
        );
        const items = visible.slice(input.cursor, input.cursor + input.limit);
        return {
          items,
          nextCursor:
            input.cursor + items.length < visible.length ? input.cursor + items.length : null
        };
      },
      readSnapshot(input) {
        assertCollaborationCanvasScope(input);
        return packageSnapshots!.read(input);
      },
      createSnapshot(input) {
        assertCollaborationCanvasScope(input);
        return packageSnapshots!.create(input);
      },
      restoreSnapshot(input) {
        assertCollaborationCanvasScope(input);
        return packageSnapshots!.restore(input);
      }
    };
    authorization = new OperatorTokenRegistry(server.database, config.operatorCredentials, clock);
    provisionConfiguredOperatorSessions({
      database: server.database,
      credentials: config.operatorCredentials,
      trustedProjectIds: [...new Set(runtimeRegistry.expansions.map((canvas) => canvas.projectId))],
      serverAdminAnchorWorkspaceId:
        runtimeRegistry.expansions[0]?.workspaceId ??
        ownerRuntimeRegistry.expansions[0]?.workspaceId,
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
          {
            workspaceId:
              workspaceIdentity.workspaceForLegacyProject(invitation.projectId) ??
              (() => {
                throw new Error("human_observer_workspace_scope_unresolved");
              })(),
            projectId: invitation.projectId
          },
          { kind: "invitation" },
          invitation.consumedAt ?? invitation.revokedAt ?? invitation.createdAt
        );
      }
    });
    humanIdentityForInteractions = humanIdentity;
    const humanMembership = new HumanMembershipService({
      repository: humanIdentity,
      projectAuthority: runtimeRegistry,
      workspaceForProject: (projectId) =>
        workspaceIdentity.ensureWorkspaceForLegacyProject(projectId),
      clock
    });
    const commentAttachmentRepository = new CommentAttachmentRepository(server.database, {
      onMutationInTransaction: (input) => {
        initializedHumanObserverJournal.appendInCallerTransaction(
          {
            workspaceId: input.workspaceId,
            projectId: input.projectId
          },
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
      const scopedActivityRepository = new ActivityRepository(server.database, {
        workspaceId,
        onInsertedInTransaction: (record) =>
          appendHumanObserverActivity(initializedHumanObserverJournal, workspaceId, record)
      });
      commentServices.set(
        serviceKey,
        new CommentService({
          workspaceId,
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
          authorMembershipActive(humanPrincipalId) {
            return workspaceIdentity
              .listMembershipViews(workspaceId)
              .some(
                (candidate) =>
                  candidate.humanPrincipalId === humanPrincipalId && candidate.revokedAt === null
              );
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
    const membershipPort = createIdentityMembershipPort({ workspaceIdentity });
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
    for (const { workspaceId, projectId } of runtimeRegistry.locators) {
      const serviceKey = assignmentServiceKey(workspaceId, projectId);
      if (assignmentServices.has(serviceKey)) continue;
      const packagePort = runtimeRegistry.scopedProjectWorkItemPackagePort({
        workspaceId,
        projectId
      });
      if (!packagePort) throw new Error("trusted_project_work_item_port_missing");
      assignmentServices.set(
        serviceKey,
        new WorkAssignmentService({
          workspaceId,
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
    attachReverseProxyWebSocketReadiness({ config, upgradeRouter, transportAdmission });
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
      onHostAvailable: async (hostId) => {
        await coordination.coordinator.reenterWaitingForHost(hostId);
      },
      transportAdmission
    });
    humanObserverWebSockets = attachHumanObserverWebSocketServer({
      upgradeRouter,
      journal: initializedHumanObserverJournal,
      repository: humanIdentity,
      workspaceIdentity,
      projectAccess: initializedProjectAccess,
      projectAuthority: runtimeRegistry,
      maxPayloadBytes: config.limits.maxWebSocketPayloadBytes,
      shutdownTimeoutMs: config.limits.shutdownTimeoutMs,
      transportAdmission,
      allowedClientOrigins: config.allowedClientOrigins ?? undefined,
      clock
    });
    const canvasCollaboration = await createCanvasCollaborationComposition({
      database: server.database,
      upgradeRouter,
      identity: humanIdentity,
      workspaceIdentity,
      projectAccess: initializedProjectAccess,
      projectAuthority: runtimeRegistry,
      expansions: runtimeRegistry.expansions,
      observerJournal: initializedHumanObserverJournal,
      transportAdmission,
      maxPayloadBytes: config.limits.maxWebSocketPayloadBytes,
      shutdownTimeoutMs: config.limits.shutdownTimeoutMs,
      allowedClientOrigins: config.allowedClientOrigins ?? undefined,
      clock
    });
    canvasPresenceWebSockets = canvasCollaboration.presenceWebSockets;
    canvasLiveSyncWebSockets = canvasCollaboration.liveSyncWebSockets;
    canvasCommandWebSockets = canvasCollaboration.commandWebSockets;
    const contentVersionRepository = canvasCollaboration.contentVersions;
    const contentVersionService = canvasCollaboration.contentVersionService;
    const canvasCommandService = canvasCollaboration.commandService;
    const attachedWebSockets = webSockets;
    const control = new RemoteControlService({
      authorization,
      enrollments,
      hosts: coordination.hosts,
      agentEndpoints: coordination.agentEndpoints,
      operations: coordination.operations,
      dispatches: coordination.dispatches,
      coordinator: coordination.coordinator,
      events: coordination.acpEvents,
      interactions: coordination.interactions,
      disconnectHost: (hostId) => attachedWebSockets.disconnectHost(hostId),
      workspaceIdentity,
      authorizeProjectScope: (scope) => {
        if (!runtimeRegistry.hasScope(scope)) throw new Error("operator_project_forbidden");
      },
      authorizeCanvas: (scope) => {
        if (!runtimeRegistry.hasScope(scope)) throw new Error("operator_project_forbidden");
      },
      resolveOwnerRuntimeScope: ({ projectId, canvasId }) => {
        const matches = ownerRuntimeRegistry.expansions.filter(
          (scope) => scope.projectId === projectId && scope.canvasId === canvasId
        );
        if (matches.length !== 1) return undefined;
        const match = matches[0]!;
        return {
          workspaceId: match.workspaceId,
          projectId: match.projectId,
          canvasId: match.canvasId
        };
      },
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
        assertHumanScopeAuthorized({
          actor: context,
          scope,
          access: initializedProjectAccess,
          workspaceIdentity
        });
      }
    });
    requestListener = createDistributedHttpRequestListener({
      readiness,
      inflightRequests,
      workspaceIdentity,
      projectAccess: initializedProjectAccess,
      humanIdentity,
      projectAuthority: runtimeRegistry,
      transportAdmission,
      registryService,
      agentEndpointCatalog: coordination.agentEndpoints,
      humanRemoteControl,
      resolveAssignmentService: (workspaceId, projectId) =>
        assignmentServices.get(assignmentServiceKey(workspaceId, projectId)),
      acquireAuthorityService,
      contentVersionService,
      contentVersions: contentVersionRepository,
      canvasCommandService,
      resolveCommentService: (workspaceId, projectId) =>
        commentServices.get(collaborationScopeKey(workspaceId, projectId)),
      enrollments,
      setupCodes,
      authorization,
      hosts: coordination.hosts,
      dispatches: coordination.dispatches,
      artifactAuthorization: coordination.artifactAuthorization,
      artifacts: initializedArtifactStore,
      humanMembership,
      commentAttachments,
      operatorControl: control,
      serverVersion: serverPackageVersion,
      maxArtifactBytes: config.limits.maxArtifactBytes,
      maxWebSocketPayloadBytes: config.limits.maxWebSocketPayloadBytes,
      clock
    });
    options.httpServer.on("request", requestListener);
    const attachedRequestListener = requestListener;
    remoteCoordinationMaintenance = new RemoteCoordinationMaintenance(
      () => coordination.reconcile(),
      config.limits.heartbeatIntervalMs
    );
    remoteCoordinationMaintenance.start();
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
        canvasLiveSyncWebSockets,
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
      exposureLeaseStore: new SqliteExposureLeaseStore(server.database),
      readiness: () => readiness.readiness(),
      beginDrain,
      drainTransports,
      async close() {
        beginDrain();
        closePromise ??= (async () => {
          const errors: unknown[] = [];
          try {
            await remoteCoordinationMaintenance?.close();
          } catch (error) {
            errors.push(error);
          }
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
              closeRuntimeRegistry: closeRuntimeRegistries
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
      await remoteCoordinationMaintenance?.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
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
        canvasLiveSyncWebSockets,
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
          closeRuntimeRegistry: closeRuntimeRegistries
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
