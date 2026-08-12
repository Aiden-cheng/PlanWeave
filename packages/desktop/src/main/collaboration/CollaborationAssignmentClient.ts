import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  assignmentDisplayProjectionSchema,
  assignmentListPageSchema,
  assignmentListQuerySchema,
  assignmentUpdateWireCommandSchema,
  eligibleAssigneesResponseSchema,
  eligibleHostBatchRequestSchema,
  eligibleHostBatchResponseSchema,
  type AssignmentDisplayProjection,
  type AssignmentListPage,
  type AssignmentUpdateWireCommand,
  type EligibleAssigneesResponse,
  type EligibleHostBatchRequest,
  type EligibleHostBatchResponse
} from "@planweave-ai/collaboration-protocol/work/assignment";
import type { z } from "zod";
import { CollaborationClientError } from "./collaborationErrors.js";
import type { CollaborationHttpTransport } from "./collaborationHttpTransport.js";

/** HTTP client for legacy assignment projections and eligible-assignee reads. */
export class CollaborationAssignmentClient {
  constructor(
    private readonly transport: CollaborationHttpTransport,
    private readonly projectId: string
  ) {}

  getAssignment(workItem: WorkItemRef, signal?: AbortSignal): Promise<AssignmentDisplayProjection> {
    const params = new URLSearchParams({ workItem: JSON.stringify(workItem) });
    return this.transport.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/assignments?${params}`,
      assignmentDisplayProjectionSchema,
      { signal }
    );
  }

  listAssignments(
    query: z.input<typeof assignmentListQuerySchema> = {},
    signal?: AbortSignal
  ): Promise<AssignmentListPage> {
    const parsed = assignmentListQuerySchema.parse(query);
    const params = new URLSearchParams({
      cursor: String(parsed.cursor),
      limit: String(parsed.limit)
    });
    if (parsed.canvasId) params.set("canvasId", parsed.canvasId);
    if (parsed.workItems) params.set("workItems", JSON.stringify(parsed.workItems));
    return this.transport.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/assignments/list?${params}`,
      assignmentListPageSchema,
      { signal }
    );
  }

  updateAssignment(
    command: AssignmentUpdateWireCommand,
    signal?: AbortSignal
  ): Promise<AssignmentDisplayProjection> {
    const body = assignmentUpdateWireCommandSchema.parse(command);
    return this.transport.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/assignments`,
      assignmentDisplayProjectionSchema,
      { body, signal }
    );
  }

  listEligibleAssignees(
    workItem: WorkItemRef,
    signal?: AbortSignal
  ): Promise<EligibleAssigneesResponse> {
    const params = new URLSearchParams({ workItem: JSON.stringify(workItem) });
    return this.transport.json(
      "GET",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/assignments/eligible-assignees?${params}`,
      eligibleAssigneesResponseSchema,
      { signal }
    );
  }

  async listEligibleHostsBatch(
    request: EligibleHostBatchRequest,
    signal?: AbortSignal
  ): Promise<EligibleHostBatchResponse> {
    const body = eligibleHostBatchRequestSchema.parse(request);
    const response = await this.transport.json(
      "POST",
      `/api/v1/projects/${encodeURIComponent(this.projectId)}/assignments/eligible-hosts/batch`,
      eligibleHostBatchResponseSchema,
      { body, signal }
    );
    const matchesRequest =
      response.items.length === body.workItems.length &&
      response.items.every((item, index) => {
        const requested = body.workItems[index];
        return (
          requested !== undefined &&
          item.index === index &&
          item.workItem.canvasId === requested.canvasId &&
          item.workItem.blockRef === requested.blockRef
        );
      });
    if (!matchesRequest) {
      throw new CollaborationClientError({
        kind: "validation",
        code: "collaboration_eligible_host_batch_mismatch",
        message: "Eligible Host batch response does not match the requested work items.",
        retryable: false
      });
    }
    return response;
  }
}
