import { describe, expect, it } from "vitest";
import {
  agentHostCredentialBindingSchema,
  agentHostIdentitySchema,
  assertWorkspaceIdentityScope,
  assertWorkspaceIdentityViewRedacted,
  deviceSessionSchema,
  evaluateAgentHostUsability,
  evaluateDeviceSessionUsability,
  evaluateOperatorSessionUsability,
  humanUpdateDisplayNameRequestSchema,
  operatorSessionSchema,
  workspaceMembershipSchema,
  workspaceSchema
} from "../identity.js";
import {
  exampleAgentHostIdentity,
  exampleDeviceSession,
  exampleIdentityMigrationMatrix,
  exampleIdentityMigrationState,
  exampleIdentityMigrationStateFixtures,
  exampleLegacyProjectWorkspaceMapping,
  exampleOperatorSession,
  exampleWorkspace,
  exampleWorkspaceMembership,
  exampleWorkspacePrincipal
} from "../fixtures/collaboration.js";
import { identityMigrationMatrixSchema, identityMigrationStateSchema } from "../migration.js";
import { workspaceConnectionProfileSchema } from "../connection.js";

const now = new Date("2030-01-01T12:00:00.000Z");

describe("Workspace identity contracts", () => {
  it("keeps durable identity rows strict and workspace-scoped", () => {
    expect(workspaceSchema.parse(exampleWorkspace).workspaceId).toBe("workspace-demo-001");
    expect(humanPrincipalId(exampleWorkspacePrincipal)).toBe("human-owner-001");
    expect(exampleWorkspaceMembership.workspaceId).toBe(exampleWorkspace.workspaceId);
    expect(() =>
      workspaceMembershipSchema.parse({
        ...exampleWorkspaceMembership,
        projectRoot: "workspace-root"
      })
    ).toThrow();
    expect(() => workspaceSchema.parse({ ...exampleWorkspace, command: "/bin/sh" })).toThrow();
  });

  it("rejects cross-workspace assembled references", () => {
    expect(() =>
      assertWorkspaceIdentityScope({
        workspace: { workspaceId: "workspace-demo-001" },
        principal: { workspaceId: "workspace-other-001" }
      })
    ).toThrow("cross_workspace_reference");
    expect(() =>
      assertWorkspaceIdentityScope({
        workspace: { workspaceId: "workspace-demo-001" },
        principal: { workspaceId: "workspace-demo-001" },
        project: { workspaceId: "workspace-other-001", projectId: "project-1" }
      })
    ).toThrow("cross_workspace_reference");
  });

  it("rejects expired and revoked credentials before authorization", () => {
    expect(
      evaluateDeviceSessionUsability({
        session: exampleDeviceSession,
        workspaceId: exampleWorkspace.workspaceId,
        now
      })
    ).toEqual({ usable: true, state: "active" });
    expect(
      evaluateDeviceSessionUsability({
        session: deviceSessionSchema.parse({
          ...exampleDeviceSession,
          expiresAt: "2030-01-01T11:00:00.000Z"
        }),
        workspaceId: exampleWorkspace.workspaceId,
        now
      })
    ).toEqual({ usable: false, state: "expired" });
    expect(
      evaluateOperatorSessionUsability({
        session: operatorSessionSchema.parse({
          ...exampleOperatorSession,
          revokedAt: "2030-01-01T11:00:00.000Z"
        }),
        workspaceId: exampleWorkspace.workspaceId,
        now
      })
    ).toEqual({ usable: false, state: "revoked" });
    expect(
      evaluateAgentHostUsability({
        host: agentHostIdentitySchema.parse({
          ...exampleAgentHostIdentity,
          workspaceId: "workspace-other-001"
        }),
        workspaceId: exampleWorkspace.workspaceId,
        now
      })
    ).toEqual({ usable: false, state: "workspace_mismatch" });
  });

  it("keeps trust domains separate and only exposes redacted views", () => {
    expect(() =>
      assertWorkspaceIdentityViewRedacted({
        workspaceId: exampleWorkspace.workspaceId,
        credentialExpiresAt: "2030-01-02T00:00:00.000Z"
      })
    ).not.toThrow();
    expect(() =>
      agentHostCredentialBindingSchema.parse({
        schemaVersion: "workspace-identity/v1",
        workspaceId: exampleWorkspace.workspaceId,
        hostId: exampleAgentHostIdentity.hostId,
        credentialToken: `pw_hdev_${"A".repeat(43)}`,
        credentialExpiresAt: "2030-01-02T00:00:00.000Z"
      })
    ).toThrow();
    for (const value of [
      { credentialSha256: "a".repeat(64) },
      { nested: { credential_hash: "a".repeat(64) } },
      { credentialToken: `pw_host_${"A".repeat(43)}` },
      { enrollmentCode: `pw_enroll_${"A".repeat(43)}` },
      { projectRoot: "workspace-root" },
      { command: "codex" },
      { args: ["--version"] },
      { environment: { HOME: "/tmp" } }
    ]) {
      expect(() => assertWorkspaceIdentityViewRedacted(value)).toThrow(
        "workspace_identity_view_not_redacted"
      );
    }
  });

  it("requires explicit migration versions, markers, cutover, and fail-closed policy", () => {
    expect(exampleLegacyProjectWorkspaceMapping.workspaceId).toBe(exampleWorkspace.workspaceId);
    expect(identityMigrationStateSchema.parse(exampleIdentityMigrationState).failureCode).toBe(
      null
    );
    expect(
      identityMigrationMatrixSchema.parse(exampleIdentityMigrationMatrix).entries
    ).toHaveLength(2);
    expect(exampleIdentityMigrationStateFixtures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "completed",
          interruptionMarker: "read_cutover_complete"
        }),
        expect.objectContaining({
          status: "interrupted",
          interruptionMarker: "partial_backfill_failed"
        }),
        expect.objectContaining({
          status: "repair_required",
          interruptionMarker: "partial_backfill_failed"
        }),
        expect.objectContaining({ status: "rolled_back", interruptionMarker: "rollback_complete" })
      ])
    );
    expect(() =>
      identityMigrationStateSchema.parse({
        ...exampleIdentityMigrationState,
        status: "completed",
        interruptionMarker: "mapping_written"
      })
    ).toThrow();
    expect(() =>
      identityMigrationMatrixSchema.parse({
        ...exampleIdentityMigrationMatrix,
        entries: exampleIdentityMigrationMatrix.entries.map((entry) => ({
          ...entry,
          partialFailureReadPolicy: "legacy"
        }))
      })
    ).toThrow();
  });

  it("requires Workspace authority in new connection profiles", () => {
    expect(
      workspaceConnectionProfileSchema.parse({
        schemaVersion: "workspace-identity/v1",
        profileId: "profile-1",
        displayName: "Workspace",
        serverBaseUrl: "https://collab.example.com/",
        workspaceId: "workspace-demo-001",
        allowInsecureTransport: false
      }).workspaceId
    ).toBe(exampleWorkspace.workspaceId);
    expect(() =>
      workspaceConnectionProfileSchema.parse({
        schemaVersion: "workspace-identity/v1",
        profileId: "profile-1",
        displayName: "Workspace",
        serverBaseUrl: "https://collab.example.com/",
        workspaceId: "workspace-demo-001",
        allowInsecureTransport: false,
        deviceToken: `pw_hdev_${"A".repeat(43)}`
      })
    ).toThrow();
  });

  it("keeps display-name updates strict and normalized", () => {
    expect(humanUpdateDisplayNameRequestSchema.parse({ displayName: "  Ada Lovelace  " })).toEqual({
      displayName: "Ada Lovelace"
    });
    expect(() =>
      humanUpdateDisplayNameRequestSchema.parse({ displayName: "Ada", humanPrincipalId: "other" })
    ).toThrow();
    expect(() => humanUpdateDisplayNameRequestSchema.parse({ displayName: "   " })).toThrow();
  });
});

function humanPrincipal(value: typeof exampleWorkspacePrincipal): string {
  return value.humanPrincipalId;
}

function humanPrincipalId(value: typeof exampleWorkspacePrincipal): string {
  return humanPrincipal(value);
}
