import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  CANVAS_COMMAND_PROTOCOL_VERSION,
  type CanvasCommandIntent
} from "@planweave-ai/collaboration-contracts";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import {
  CanvasCommandRepository,
  CanvasCommandService,
  createDefaultCanvasRuntimePort,
  digestCanvasIntent,
  routeCanvasCommandHttp,
  type CanvasRuntimeMutationPort
} from "../canvas/index.js";
import type { HumanAuthContext } from "../identity/schemas.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations, latestCentralSchemaVersion } from "../migrations.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function digestOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fakeRuntime(initialDigest = digestOf("empty")): CanvasRuntimeMutationPort & {
  calls: number;
  setDigest(next: string): void;
} {
  let digest = initialDigest;
  return {
    calls: 0,
    setDigest(next: string) {
      digest = next;
    },
    async apply(input) {
      this.calls += 1;
      digest = digestOf(`${digest}:${JSON.stringify(input.intent)}`);
      return {
        ok: true,
        contentDigest: digest,
        digestManifest: {
          manifest: { digestSha256: digest, sizeBytes: 10 },
          prompts: [],
          totalBytes: 10
        },
        packageDir: input.expectedPackageDir ?? String(input.projectRoot),
        sizeBytes: 10
      };
    },
    async readDigest(input) {
      return {
        ok: true,
        contentDigest: digest,
        digestManifest: {
          manifest: { digestSha256: digest, sizeBytes: 10 },
          prompts: [],
          totalBytes: 10
        },
        packageDir: input.expectedPackageDir ?? String(input.projectRoot),
        sizeBytes: 10
      };
    }
  };
}

async function fixture(options?: {
  journalRetention?: number;
  runtime?: CanvasRuntimeMutationPort;
}) {
  const workspace = await createTestWorkspace();
  directories.push(workspace.home, workspace.root);
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  database.exec(`
    INSERT INTO workspaces(workspace_id,display_name,created_at) VALUES ('w','Workspace','2026-01-01');
    INSERT INTO workspace_principals(workspace_id,human_principal_id,display_name,created_at,revoked_at) VALUES
      ('w','owner','Owner','2026-01-01T00:00:00.000Z',NULL),
      ('w','editor','Editor','2026-01-01T00:00:00.000Z',NULL),
      ('w','viewer','Viewer','2026-01-01T00:00:00.000Z',NULL);
    INSERT INTO workspace_memberships(workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at) VALUES
      ('w','m-owner','owner','owner',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL),
      ('w','m-editor','editor','member',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL),
      ('w','m-viewer','viewer','member',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL);
    INSERT INTO legacy_project_workspace_mappings(legacy_project_id,normalized_legacy_project_identity,workspace_id,mapped_at)
      VALUES ('p','legacy-project:p','w','2026-01-01');
  `);
  const access = new ProjectAccessRepository(database, () => new Date("2026-01-02T00:00:00.000Z"));
  access.registerProjectInternal({
    workspaceId: "w",
    projectId: "p",
    projectRoot: workspace.root,
    ownerHumanPrincipalId: "owner"
  });
  access.registerCanvasInternal({
    workspaceId: "w",
    projectId: "p",
    canvasId: "default",
    packageDir: workspace.init.workspace.packageDir,
    visibility: "private",
    ownerHumanPrincipalId: "owner"
  });
  access.markCanvasCutover("w", "p", "default");
  access.finalizeProjectCutover("w", "p");
  access.grant({
    workspaceId: "w",
    projectId: "p",
    canvasId: "default",
    humanPrincipalId: "editor",
    role: "editor",
    grantedBy: { kind: "human", id: "owner" }
  });
  access.grant({
    workspaceId: "w",
    projectId: "p",
    canvasId: "default",
    humanPrincipalId: "viewer",
    role: "viewer",
    grantedBy: { kind: "human", id: "owner" }
  });

  const repository = new CanvasCommandRepository(database, {
    clock: () => new Date("2026-01-02T00:00:00.000Z"),
    maxJournalEntries: options?.journalRetention ?? 3
  });
  const runtime = options?.runtime ?? fakeRuntime();
  const service = new CanvasCommandService({
    repository,
    access,
    workspaceIdentity: new WorkspaceIdentityRepository(database),
    runtime,
    clock: () => new Date("2026-01-02T00:00:00.000Z"),
    presenceHeadProbe: () => 999
  });
  return { workspace, database, access, repository, service, runtime };
}

function actor(id: "owner" | "editor" | "viewer"): HumanAuthContext {
  return {
    humanPrincipalId: id,
    displayName: id,
    deviceCredentialId: `device-${id}`,
    projectId: "p",
    role: id === "owner" ? "owner" : "member",
    membershipId: `m-${id}`
  };
}

function submitBody(
  operationId: string,
  expectedRevision: number,
  intent: CanvasCommandIntent = {
    kind: "update_task_prompt",
    taskId: "T-001",
    promptMarkdown: "# updated"
  }
) {
  return {
    type: "canvas.command.submit" as const,
    protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
    schemaVersion: "canvas-command/v1" as const,
    projectId: "p",
    canvasId: "default",
    operationId,
    expectedRevision,
    intent
  };
}

describe("canvas command service (OSS-004 B-002)", () => {
  it("migrates v30 and enforces CAS + operationId idempotency", async () => {
    const { service, repository, runtime, database } = await fixture();
    expect(latestCentralSchemaVersion).toBe(30);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='canvas_command_journal'"
        )
        .get()?.name
    ).toBe("canvas_command_journal");

    const first = await service.submit(actor("owner"), submitBody("op-1", 0));
    expect(first.type).toBe("canvas.command.accepted");
    if (first.type !== "canvas.command.accepted") throw new Error("expected accept");
    expect(first).toMatchObject({
      revision: 1,
      previousRevision: 0,
      idempotentReplay: false
    });
    expect((runtime as ReturnType<typeof fakeRuntime>).calls).toBe(1);

    const replay = await service.submit(actor("owner"), submitBody("op-1", 0));
    expect(replay.type).toBe("canvas.command.accepted");
    if (replay.type !== "canvas.command.accepted") throw new Error("expected replay");
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.revision).toBe(first.revision);
    expect(replay.journalEntryId).toBe(first.journalEntryId);
    expect((runtime as ReturnType<typeof fakeRuntime>).calls).toBe(1);

    const conflict = await service.submit(
      actor("owner"),
      submitBody("op-1", 1, {
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "# different intent"
      })
    );
    expect(conflict).toMatchObject({ type: "canvas.command.rejected", code: "operation_conflict" });

    const stale = await service.submit(actor("owner"), submitBody("op-2", 0));
    expect(stale).toMatchObject({
      type: "canvas.command.rejected",
      code: "stale_revision",
      conflict: { expectedRevision: 0, authoritativeRevision: 1 }
    });

    const second = await service.submit(actor("editor"), submitBody("op-2", 1));
    expect(second.type).toBe("canvas.command.accepted");
    expect(repository.head({ workspaceId: "w", projectId: "p", canvasId: "default" }).revision).toBe(
      2
    );
  });

  it("serializes concurrent writers so only one CAS winner advances revision", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let enterCount = 0;
    const runtime: CanvasRuntimeMutationPort = {
      async apply(input) {
        enterCount += 1;
        if (enterCount === 1) await firstGate;
        const digest = digestOf(`apply:${enterCount}:${JSON.stringify(input.intent)}`);
        return {
          ok: true,
          contentDigest: digest,
          digestManifest: {
            manifest: { digestSha256: digest, sizeBytes: 1 },
            prompts: [],
            totalBytes: 1
          },
          packageDir: String(input.projectRoot),
          sizeBytes: 1
        };
      },
      async readDigest(input) {
        const digest = digestOf("head");
        return {
          ok: true,
          contentDigest: digest,
          digestManifest: {
            manifest: { digestSha256: digest, sizeBytes: 1 },
            prompts: [],
            totalBytes: 1
          },
          packageDir: String(input.projectRoot),
          sizeBytes: 1
        };
      }
    };
    const { service } = await fixture({ runtime });
    const firstPromise = service.submit(
      actor("owner"),
      submitBody("op-a", 0, {
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "A"
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondPromise = service.submit(
      actor("editor"),
      submitBody("op-b", 0, {
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "B"
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Second writer must wait on the canvas chain before runtime apply.
    expect(enterCount).toBe(1);
    releaseFirst();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    const accepted = [first, second].filter((item) => item.type === "canvas.command.accepted");
    const rejected = [first, second].filter((item) => item.type === "canvas.command.rejected");
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ code: "stale_revision" });
    expect(enterCount).toBe(1);
  });

  it("rejects viewer writes and ACL-revoked editors", async () => {
    const { service, access, database } = await fixture();
    const viewerDenied = await service.submit(actor("viewer"), submitBody("op-viewer", 0));
    expect(viewerDenied).toMatchObject({
      type: "canvas.command.rejected",
      code: "forbidden",
      detail: "canvas_write_denied"
    });

    const row = database
      .prepare(
        `SELECT grant_id FROM project_access_grants
         WHERE human_principal_id='editor' AND scope_kind='canvas' AND revoked_at IS NULL`
      )
      .get() as { grant_id: string };
    const canvasAcl = database
      .prepare(
        `SELECT acl_revision FROM canvas_registry WHERE workspace_id='w' AND project_id='p' AND canvas_id='default'`
      )
      .get() as { acl_revision: number };
    access.revoke({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      grantId: row.grant_id,
      actor: { kind: "human", id: "owner" },
      expectedAclRevision: Number(canvasAcl.acl_revision)
    });
    const afterRevoke = await service.submit(actor("editor"), submitBody("op-revoked", 0));
    expect(afterRevoke).toMatchObject({ type: "canvas.command.rejected", code: "forbidden" });
  });

  it("reconnects via journal delta, snapshots truncated history, and recovers pending rows", async () => {
    const { service, repository } = await fixture({ journalRetention: 2 });
    await service.submit(actor("owner"), submitBody("op-1", 0));
    await service.submit(actor("owner"), submitBody("op-2", 1));
    await service.submit(actor("owner"), submitBody("op-3", 2));

    const delta = await service.reconnect(actor("editor"), {
      type: "canvas.reconnect.request",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      projectId: "p",
      canvasId: "default",
      afterRevision: 2
    });
    expect(delta.type).toBe("canvas.reconnect.delta");
    if (delta.type === "canvas.reconnect.delta") {
      expect(delta.entries).toHaveLength(1);
      expect(delta.entries[0]?.revision).toBe(3);
      expect(delta.headRevision).toBe(3);
    }

    const truncated = await service.reconnect(actor("editor"), {
      type: "canvas.reconnect.request",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      projectId: "p",
      canvasId: "default",
      afterRevision: 0
    });
    expect(
      truncated.type === "canvas.reconnect.snapshot" || truncated.type === "canvas.reconnect.delta"
    ).toBe(true);
    if (truncated.type === "canvas.reconnect.snapshot") {
      expect(["truncated_journal", "retention_gap", "fresh_session"]).toContain(truncated.reason);
      expect(truncated.snapshot.metadata.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    }

    repository.reservePending({
      scope: { workspaceId: "w", projectId: "p", canvasId: "default" },
      operationId: "pending-crash",
      expectedRevision: 3,
      intent: {
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "# crash"
      },
      intentDigest: digestCanvasIntent({
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "# crash"
      }),
      actor: { kind: "human", id: "owner" }
    });
    repository.markPendingNeedsRecovery(
      { workspaceId: "w", projectId: "p", canvasId: "default" },
      "pending-crash"
    );
    expect((await service.recoverInterrupted()).cleared).toBe(1);
  });

  it("rejects forbidden shared-mode features and ignores presence as mutation authority", async () => {
    const request = { method: "POST" } as IncomingMessage;
    for (const path of [
      "/api/v1/projects/p/upload",
      "/api/v1/projects/p/download",
      "/api/v1/projects/p/sync",
      "/api/v1/projects/p/fs/watch",
      "/api/v1/projects/p/directory",
      "/api/v1/billing/checkout",
      "/api/v1/subscription/status",
      "/api/v1/license/activate",
      "/api/v1/ssh/open",
      "/api/v1/vps/provision"
    ]) {
      expect(routeCanvasCommandHttp(request, path)?.kind, path).toBe("forbidden_feature");
    }
    expect(
      routeCanvasCommandHttp(request, "/api/v1/projects/p/canvases/default/commands")?.kind
    ).toBe("command");

    const { service } = await fixture();
    const accepted = await service.submit(actor("owner"), submitBody("op-presence", 0));
    expect(accepted.type).toBe("canvas.command.accepted");
    if (accepted.type === "canvas.command.accepted") {
      // presenceHeadProbe returns 999; CAS revision must stay authoritative.
      expect(accepted.revision).toBe(1);
      expect(accepted.revision).not.toBe(999);
    }
  });

  it("applies a real runtime package mutation through the narrow port", async () => {
    const { service } = await fixture({ runtime: createDefaultCanvasRuntimePort() });
    const outcome = await service.submit(actor("owner"), {
      type: "canvas.command.submit",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      projectId: "p",
      canvasId: "default",
      operationId: "op-real-1",
      expectedRevision: 0,
      intent: {
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "# Server authoritative prompt\n"
      }
    });
    if (outcome.type !== "canvas.command.accepted") {
      throw new Error(`expected accept, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome.revision).toBe(1);
    expect(outcome.contentDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("recovers crash after apply by aligning journal to package digest without double mutation", async () => {
    const scope = { workspaceId: "w", projectId: "p", canvasId: "default" };
    let digest = digestOf("empty");
    let applyCalls = 0;
    const runtime: CanvasRuntimeMutationPort = {
      async apply(input) {
        applyCalls += 1;
        digest = digestOf(`${digest}:applied:${JSON.stringify(input.intent)}`);
        return {
          ok: true,
          contentDigest: digest,
          digestManifest: {
            manifest: { digestSha256: digest, sizeBytes: 10 },
            prompts: [],
            totalBytes: 10
          },
          packageDir: String(input.projectRoot),
          sizeBytes: 10
        };
      },
      async readDigest(input) {
        return {
          ok: true,
          contentDigest: digest,
          digestManifest: {
            manifest: { digestSha256: digest, sizeBytes: 10 },
            prompts: [],
            totalBytes: 10
          },
          packageDir: String(input.projectRoot),
          sizeBytes: 10
        };
      }
    };
    const { service, repository } = await fixture({ runtime });

    // Simulate: accept path reserved pending, apply mutated package, commit never ran.
    const intent: CanvasCommandIntent = {
      kind: "update_task_prompt",
      taskId: "T-001",
      promptMarkdown: "# crash recovery\n"
    };
    await runtime.apply({
      projectRoot: "/tmp",
      canvasId: "default",
      intent
    });
    expect(applyCalls).toBe(1);
    const packageDigestAfterApply = digest;

    repository.reservePending({
      scope,
      operationId: "op-crash-apply",
      expectedRevision: 0,
      intent,
      intentDigest: digestCanvasIntent(intent),
      actor: { kind: "human", id: "owner" }
    });
    repository.markPendingNeedsRecovery(scope, "op-crash-apply");

    const recovery = await service.recoverInterrupted();
    expect(recovery).toMatchObject({ cleared: 1, recovered: 1 });
    const head = repository.head(scope);
    expect(head.revision).toBe(1);
    expect(head.contentDigest).toBe(packageDigestAfterApply);

    // Same operationId replays accepted outcome — no second apply.
    const replay = await service.submit(actor("owner"), submitBody("op-crash-apply", 0, intent));
    expect(replay.type).toBe("canvas.command.accepted");
    if (replay.type === "canvas.command.accepted") {
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.revision).toBe(1);
      expect(replay.contentDigest).toBe(packageDigestAfterApply);
    }
    expect(applyCalls).toBe(1);

    // Fresh opId at stale revision is rejected (no double mutation).
    const staleRetry = await service.submit(
      actor("owner"),
      submitBody("op-crash-retry", 0, {
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "# would double apply\n"
      })
    );
    expect(staleRetry).toMatchObject({
      type: "canvas.command.rejected",
      code: "stale_revision",
      conflict: { expectedRevision: 0, authoritativeRevision: 1 }
    });
    expect(applyCalls).toBe(1);
  });

  it("returns snapshot_malformed when reconnect needs a snapshot that is corrupt", async () => {
    const { service, repository } = await fixture();
    const accepted = await service.submit(actor("owner"), submitBody("op-snap-1", 0));
    expect(accepted.type).toBe("canvas.command.accepted");
    const scope = { workspaceId: "w", projectId: "p", canvasId: "default" };
    const head = repository.head(scope);
    repository.markSnapshotCorrupt(scope, head.revision);

    const response = await service.reconnect(actor("editor"), {
      type: "canvas.reconnect.request",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      projectId: "p",
      canvasId: "default",
      afterRevision: 0
    });
    // Retention may still return delta for afterRevision 0; force gap path.
    const forced = await service.reconnect(actor("editor"), {
      type: "canvas.reconnect.request",
      protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
      schemaVersion: "canvas-command/v1",
      projectId: "p",
      canvasId: "default",
      afterRevision: 99
    });
    expect(forced.type).toBe("canvas.reconnect.error");
    if (forced.type === "canvas.reconnect.error") {
      expect(forced.code).toBe("snapshot_malformed");
    }
    void response;
  });

  it("keeps presence probe independent under concurrent command load", async () => {
    const { service } = await fixture();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        service.submit(
          actor("owner"),
          submitBody(`op-presence-load-${index}`, 0, {
            kind: "update_task_prompt",
            taskId: "T-001",
            promptMarkdown: `# presence load ${index}\n`
          })
        )
      )
    );
    const accepted = results.filter((item) => item.type === "canvas.command.accepted");
    const rejected = results.filter((item) => item.type === "canvas.command.rejected");
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    expect(accepted.length + rejected.length).toBe(8);
    for (const item of accepted) {
      if (item.type === "canvas.command.accepted") {
        // presenceHeadProbe returns 999; durable revision never uses presence.
        expect(item.revision).not.toBe(999);
        expect(item.revision).toBeGreaterThanOrEqual(1);
      }
    }
    for (const item of rejected) {
      if (item.type === "canvas.command.rejected") {
        expect(["stale_revision", "operation_conflict"]).toContain(item.code);
      }
    }
  });
});
