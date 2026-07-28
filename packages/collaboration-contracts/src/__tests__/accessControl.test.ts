import { describe, expect, it } from "vitest";
import {
  accessCapabilities,
  accessCapabilityFlags,
  accessCapabilityMatrix,
  accessMutationRequestSchema,
  accessMutationResultSchema,
  currentCanvasAccessViewSchema,
  canvasPersonAccessViewSchema,
  effectiveAccessEvaluationSchema,
  evaluateEffectiveAccess,
  loopbackOwnerConnectionRequestSchema,
  loopbackProjectRegistrationRequestSchema,
  loopbackServerLifecycleRequestSchema,
  loopbackServerProfileSchema,
  loopbackServerStatusSchema,
  roleHasAccessCapability,
  serverAccessMutationContextSchema,
  type ProjectAccessRole
} from "../index.js";

const workspaceId = "workspace-acl-001";
const projectId = "project-acl-001";
const canvasId = "canvas-acl-001";
const actorId = "human-acl-001";
const timestamp = "2030-01-01T00:00:00.000Z";

function project(visibility: "private" | "shared" = "private", owner = "human-owner-001") {
  return {
    schemaVersion: "project-access/v1" as const,
    registry: { projectRegistryId: "registry-project-001", workspaceId, projectId },
    visibility,
    acl: { revision: 3, updatedAt: timestamp },
    owner,
    updatedAt: timestamp
  };
}

function canvas(visibility: "private" | "shared" = "private", owner = "human-owner-001") {
  return {
    schemaVersion: "project-access/v1" as const,
    registry: {
      projectRegistryId: "registry-project-001",
      canvasRegistryId: "registry-canvas-001",
      workspaceId,
      projectId,
      canvasId
    },
    visibility,
    acl: { revision: 5, updatedAt: timestamp },
    owner,
    updatedAt: timestamp
  };
}

function grant(scopeKind: "project" | "canvas", role: "viewer" | "editor") {
  return {
    schemaVersion: "project-access/v1" as const,
    grantId: `grant-${scopeKind}-${role}`,
    workspaceId,
    projectId,
    scopeKind,
    canvasId: scopeKind === "canvas" ? canvasId : null,
    humanPrincipalId: actorId,
    role,
    aclRevision: 5,
    grantedBy: { kind: "human" as const, id: "human-owner-001", displayName: "Owner" },
    grantedAt: timestamp,
    revokedAt: null
  };
}

function evaluation(input: {
  projectVisibility?: "private" | "shared";
  canvasVisibility?: "private" | "shared";
  projectOwner?: string;
  canvasOwner?: string;
  membership?: "active" | "missing" | "revoked";
  session?: "active" | "missing" | "expired" | "revoked";
  projectGrant?: ReturnType<typeof grant> | null;
  canvasGrant?: ReturnType<typeof grant> | null;
} = {}) {
  return {
    scope: { scopeKind: "canvas" as const, workspaceId, projectId, canvasId },
    humanPrincipalId: actorId,
    membership: input.membership ?? "active",
    session: input.session ?? "active",
    project: project(input.projectVisibility, input.projectOwner),
    canvas: canvas(input.canvasVisibility, input.canvasOwner),
    projectGrant: input.projectGrant ?? null,
    canvasGrant: input.canvasGrant ?? null
  };
}

describe("scoped access capability contracts", () => {
  it("defines the complete role × capability matrix without editor grant management", () => {
    const expected: Record<ProjectAccessRole, readonly string[]> = {
      viewer: ["list", "read"],
      editor: ["list", "read", "persistent_canvas_command", "assignment", "comment"],
      owner: [...accessCapabilities]
    };
    for (const role of Object.keys(expected) as ProjectAccessRole[]) {
      for (const capability of accessCapabilities) {
        expect(roleHasAccessCapability(role, capability)).toBe(expected[role].includes(capability));
      }
      expect(accessCapabilityMatrix[role]).toEqual(expected[role]);
    }
    expect(accessCapabilityFlags("viewer").persistent_canvas_command).toBe(false);
    expect(accessCapabilityFlags("editor").grant).toBe(false);
    expect(accessCapabilityFlags("editor").visibility).toBe(false);
  });

  it("keeps every role matrix result stable across independent project/canvas visibility", () => {
    for (const projectVisibility of ["private", "shared"] as const) {
      for (const canvasVisibility of ["private", "shared"] as const) {
        for (const role of ["viewer", "editor"] as const) {
          const result = evaluateEffectiveAccess(
            evaluation({ projectVisibility, canvasVisibility, canvasGrant: grant("canvas", role) })
          );
          expect(result.effectiveRole).toBe(role);
          for (const capability of accessCapabilities) {
            expect(result.capabilities[capability]).toBe(roleHasAccessCapability(role, capability));
          }
        }
        const owner = evaluateEffectiveAccess(
          evaluation({ projectVisibility, canvasVisibility, canvasOwner: actorId })
        );
        expect(owner.effectiveRole).toBe("owner");
        expect(Object.values(owner.capabilities).every(Boolean)).toBe(true);
      }
    }
  });

  it("applies the same matrix at project scope without a canvas fallback", () => {
    for (const visibility of ["private", "shared"] as const) {
      for (const role of ["viewer", "editor"] as const) {
        const result = evaluateEffectiveAccess({
          scope: { scopeKind: "project", workspaceId, projectId, canvasId: null },
          humanPrincipalId: actorId,
          membership: "active",
          session: "active",
          project: project(visibility),
          canvas: null,
          projectGrant: grant("project", role),
          canvasGrant: null
        });
        expect(result.effectiveRole).toBe(role);
        for (const capability of accessCapabilities) {
          expect(result.capabilities[capability]).toBe(roleHasAccessCapability(role, capability));
        }
      }
      const sharedDefault = evaluateEffectiveAccess({
        scope: { scopeKind: "project", workspaceId, projectId, canvasId: null },
        humanPrincipalId: actorId,
        membership: "active",
        session: "active",
        project: project(visibility),
        canvas: null,
        projectGrant: null,
        canvasGrant: null
      });
      expect(sharedDefault.effectiveRole).toBe(visibility === "shared" ? "viewer" : null);
    }
  });

  it("maps shared membership to viewer only and makes scope precedence explicit", () => {
    const shared = evaluateEffectiveAccess(evaluation({ canvasVisibility: "shared" }));
    expect(shared).toMatchObject({
      effectiveRole: "viewer",
      roleSource: "shared_workspace_membership",
      capabilities: { persistent_canvas_command: false, assignment: false, comment: false }
    });
    expect(evaluateEffectiveAccess(evaluation()).disabledReason).toBe("scope_private");

    const inherited = evaluateEffectiveAccess(evaluation({ projectGrant: grant("project", "editor") }));
    expect(inherited).toMatchObject({ effectiveRole: "editor", roleSource: "project_grant" });
    const overridden = evaluateEffectiveAccess(
      evaluation({ projectGrant: grant("project", "editor"), canvasGrant: grant("canvas", "viewer") })
    );
    expect(overridden).toMatchObject({ effectiveRole: "viewer", roleSource: "canvas_grant" });
  });

  it("fails closed for membership, session, revoke, and cross-workspace scope transitions", () => {
    expect(evaluateEffectiveAccess(evaluation({ membership: "missing", canvasVisibility: "shared" })).disabledReason).toBe(
      "membership_missing"
    );
    expect(evaluateEffectiveAccess(evaluation({ membership: "revoked", canvasVisibility: "shared" })).disabledReason).toBe(
      "membership_revoked"
    );
    expect(evaluateEffectiveAccess(evaluation({ session: "expired", canvasVisibility: "shared" })).disabledReason).toBe(
      "session_expired"
    );
    const revoked = { ...grant("canvas", "editor"), revokedAt: timestamp };
    expect(evaluateEffectiveAccess(evaluation({ canvasGrant: revoked })).disabledReason).toBe("grant_revoked");

    const duplicateIdsInOtherWorkspace = evaluation();
    duplicateIdsInOtherWorkspace.canvas.registry.workspaceId = "workspace-other-001";
    expect(() => effectiveAccessEvaluationSchema.parse(duplicateIdsInOtherWorkspace)).toThrow(/cross_canvas/);
  });

  it("requires opaque scope CAS and binds mutation scope to authenticated workspace authority", () => {
    const request = {
      operation: "grant" as const,
      scope: { scopeKind: "canvas" as const, workspaceId, projectId, canvasId },
      expectedAclRevision: 5,
      humanPrincipalId: actorId,
      role: "editor" as const
    };
    expect(accessMutationRequestSchema.parse(request)).toEqual(request);
    expect(() => accessMutationRequestSchema.parse({ ...request, expectedAclRevision: -1 })).toThrow();
    expect(
      accessMutationResultSchema.parse({
        status: "conflict",
        reason: "acl_revision_conflict",
        aclRevision: 6
      })
    ).toMatchObject({ status: "conflict", aclRevision: 6 });
    expect(
      () =>
        serverAccessMutationContextSchema.parse({
          authenticatedWorkspaceId: "workspace-other-001",
          request
        })
    ).toThrow(/cross_workspace/);
    expect(() => accessMutationRequestSchema.parse({ ...request, path: "/tmp/project", token: "secret" })).toThrow();
  });

  it("keeps current-canvas people and loopback lifecycle read models redacted and bounded", () => {
    expect(() =>
      canvasPersonAccessViewSchema.parse({
        humanPrincipalId: actorId,
        displayName: "Editor",
        membership: "active",
        effectiveRole: "editor",
        capabilities: accessCapabilityFlags("editor"),
        disabledReason: null,
        grants: [],
        credential: "secret"
      })
    ).toThrow();

    const current = evaluateEffectiveAccess(evaluation({ canvasOwner: actorId }));
    const currentCanvasView = {
      scope: { scopeKind: "canvas" as const, workspaceId, projectId, canvasId },
      projectVisibility: "private" as const,
      canvasVisibility: "private" as const,
      projectAclRevision: 3,
      canvasAclRevision: 5,
      current,
      people: [
        {
          humanPrincipalId: actorId,
          displayName: "Owner",
          membership: "active" as const,
          effectiveRole: "owner" as const,
          capabilities: accessCapabilityFlags("owner"),
          disabledReason: null,
          grants: []
        }
      ]
    };
    expect(currentCanvasAccessViewSchema.parse(currentCanvasView)).toMatchObject({
      projectAclRevision: 3,
      canvasAclRevision: 5
    });
    expect(currentCanvasAccessViewSchema.safeParse({ ...currentCanvasView, aclRevision: 5 }).success).toBe(false);

    const loopback = {
      profileId: "loopback-001",
      displayName: "Local Server",
      serverBaseUrl: "http://127.0.0.1:8787/",
      allowInsecureTransport: true
    };
    expect(loopbackServerProfileSchema.parse(loopback)).toEqual(loopback);
    expect(() =>
      loopbackServerProfileSchema.parse({ ...loopback, serverBaseUrl: "http://example.com/" })
    ).toThrow();
    expect(() =>
      loopbackServerProfileSchema.parse({
        ...loopback,
        serverBaseUrl: "https://server.example.com/",
        allowInsecureTransport: false
      })
    ).toThrow();
    expect(loopbackServerLifecycleRequestSchema.parse({ action: "start", profile: loopback }).action).toBe("start");
    expect(loopbackServerLifecycleRequestSchema.parse({ action: "stop", profileId: loopback.profileId }).action).toBe("stop");
    expect(() =>
      loopbackServerLifecycleRequestSchema.parse({ action: "start", profile: { ...loopback, command: "sh" } })
    ).toThrow();
    expect(
      loopbackServerStatusSchema.parse({ profile: loopback, state: "running", startedAt: timestamp, reason: null }).state
    ).toBe("running");
    expect(() =>
      loopbackOwnerConnectionRequestSchema.parse({
        workspaceId,
        profile: {
          schemaVersion: "workspace-identity/v1",
          profileId: "profile-workspace-001",
          displayName: "Workspace",
          serverBaseUrl: "https://server.example.com/",
          workspaceId,
          allowInsecureTransport: false,
          setupCode: "secret"
        }
      })
    ).toThrow();
    expect(() =>
      loopbackOwnerConnectionRequestSchema.parse({
        workspaceId,
        profile: {
          schemaVersion: "workspace-identity/v1",
          profileId: "profile-remote-001",
          displayName: "Remote",
          serverBaseUrl: "https://server.example.com/",
          workspaceId,
          allowInsecureTransport: false
        }
      })
    ).toThrow(/loopback_server_requires_literal_loopback_origin/);
    expect(
      loopbackProjectRegistrationRequestSchema.parse({
        workspaceId,
        projectId,
        canvasId: "canvas-main-001",
        profileId: loopback.profileId
      })
    ).toMatchObject({ workspaceId, projectId, canvasId: "canvas-main-001" });
    expect(() =>
      loopbackProjectRegistrationRequestSchema.parse({
        workspaceId,
        projectId,
        canvasId: "canvas-main-001",
        profileId: loopback.profileId,
        localPath: "/tmp/project"
      })
    ).toThrow();
  });
});
