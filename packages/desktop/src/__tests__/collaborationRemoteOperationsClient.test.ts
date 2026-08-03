import { describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";
import {
  CollaborationRemoteOperationsClient,
  type CollaborationRemoteOperationsTransportPort
} from "../main/collaboration/CollaborationRemoteOperationsClient.js";
import type { JsonMethod } from "../main/collaboration/collaborationHttpTransport.js";

const endpoint = {
  schemaVersion: "agent-endpoint/v1",
  endpointId: "endpoint-vps",
  profileId: "codex-acp",
  agentId: "codex",
  displayName: "Codex",
  hostDisplayName: "Build Mac",
  capabilities: ["acp.codex"],
  status: "available"
} as const;

function observation(overrides: Record<string, unknown> = {}) {
  return {
    operationId: "operation-v3",
    projectId: "project-demo-001",
    canvasId: "default",
    blockRef: "T-1#B-1",
    state: "running",
    dispatchId: "dispatch-v3",
    executionAttemptId: "attempt-v3",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:01:00.000Z",
    attempt: {
      executionAttemptId: "attempt-v3",
      dispatchId: "dispatch-v3",
      status: "running",
      leaseId: "lease-v3",
      stateVersion: 1
    },
    runtime: { ref: "T-1#B-1", status: "in_progress" },
    ...overrides
  };
}

function fixture(response: unknown) {
  const json = vi.fn(
    async <T>(
      _method: JsonMethod,
      _path: string,
      schema: ZodType<T>,
      _options: { body?: unknown; signal?: AbortSignal }
    ): Promise<T> => schema.parse(response)
  );
  const transport: CollaborationRemoteOperationsTransportPort = { json };
  return { client: new CollaborationRemoteOperationsClient("project-demo-001", transport), json };
}

const v3Command = {
  schemaVersion: "remote-run/v3" as const,
  projectId: "project-demo-001",
  canvasId: "default",
  blockRef: "T-1#B-1",
  agentEndpointId: "endpoint-vps",
  idempotencyKey: "endpoint-dispatch-1",
  expectedResponsibilityRevision: 2,
  expectedReviewerRevision: 3
};

describe("CollaborationRemoteOperationsClient", () => {
  it("parses endpoint catalogs and an exact v3 observation", async () => {
    const catalogFixture = fixture({
      schemaVersion: "agent-endpoint-list/v1",
      items: [endpoint]
    });
    await expect(catalogFixture.client.listAgentEndpoints()).resolves.toEqual({
      schemaVersion: "agent-endpoint-list/v1",
      items: [endpoint]
    });

    const dispatchFixture = fixture(
      observation({ agentEndpoint: { ...endpoint, resolvedAt: "2030-01-01T00:00:00.000Z" } })
    );
    await expect(dispatchFixture.client.dispatchRemoteOperation(v3Command)).resolves.toMatchObject({
      operationId: "operation-v3",
      agentEndpoint: { endpointId: "endpoint-vps" }
    });
    expect(dispatchFixture.json).toHaveBeenCalledWith(
      "POST",
      "/api/v1/projects/project-demo-001/remote-operations",
      expect.anything(),
      { body: v3Command, signal: undefined }
    );
  });

  it("rejects a v3 response without agentEndpoint", async () => {
    const { client } = fixture(observation());
    await expect(client.dispatchRemoteOperation(v3Command)).rejects.toThrow();
  });

  it("rejects a v3 response that leaks attempt.hostId", async () => {
    const leaked = observation({
      attempt: { ...observation().attempt, hostId: "host-internal" },
      agentEndpoint: { ...endpoint, resolvedAt: "2030-01-01T00:00:00.000Z" }
    });
    const { client } = fixture(leaked);
    await expect(client.dispatchRemoteOperation(v3Command)).rejects.toThrow(
      "endpoint_observation_must_redact_host_id"
    );
  });

  it("keeps the v2 compatibility response branch", async () => {
    const { client } = fixture(observation());
    await expect(
      client.dispatchRemoteOperation({
        canvasId: "default",
        blockRef: "T-1#B-1",
        idempotencyKey: "legacy-v2"
      })
    ).resolves.toMatchObject({ operationId: "operation-v3" });
  });
});
