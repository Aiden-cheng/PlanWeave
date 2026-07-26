import { createHash } from "node:crypto";
import { z } from "zod";
import {
  decideRemoteExecutionAction,
  nextRemoteExecutionActionState,
  remoteExecutionActionRejectionCodeSchema,
  remoteExecutionActionRequestSchema,
  remoteExecutionActionStateSchema,
  type RemoteExecutionActionRequest,
  type RemoteExecutionActionRejectionCode,
  type RemoteExecutionActionDecision,
  type RemoteExecutionActionState,
  type RemoteExecutionLifecycleSnapshot
} from "./remoteExecutionLifecycle.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";

const timestampSchema = z.iso.datetime();
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

const actionRowSchema = z
  .object({
    action_id: z.string(),
    operation_id: z.string(),
    dispatch_id: z.string(),
    execution_attempt_id: z.string(),
    kind: z.string(),
    request_fingerprint: fingerprintSchema,
    request_json: z.string(),
    state: remoteExecutionActionStateSchema,
    created_at: timestampSchema,
    delivered_at: timestampSchema.nullable(),
    acknowledged_at: timestampSchema.nullable(),
    settled_at: timestampSchema.nullable(),
    rejected_at: timestampSchema.nullable(),
    rejection_code: remoteExecutionActionRejectionCodeSchema.nullable()
  })
  .strict();

export type RemoteExecutionActionRecord = {
  request: RemoteExecutionActionRequest;
  requestFingerprint: string;
  state: RemoteExecutionActionState;
  createdAt: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
  settledAt?: string;
  rejectedAt?: string;
  rejectionCode?: RemoteExecutionActionRejectionCode;
};

function serializeRequest(request: RemoteExecutionActionRequest): {
  json: string;
  fingerprint: string;
} {
  const json = JSON.stringify(request);
  return {
    json,
    fingerprint: createHash("sha256").update(json).digest("hex")
  };
}

function toRecord(row: Record<string, unknown>): RemoteExecutionActionRecord {
  const parsed = actionRowSchema.parse(row);
  if (
    (parsed.state === "rejected" && (!parsed.rejected_at || !parsed.rejection_code)) ||
    (parsed.state !== "rejected" && (parsed.rejected_at || parsed.rejection_code))
  ) {
    throw new Error("remote_action_row_rejection_mismatch");
  }
  const request = remoteExecutionActionRequestSchema.parse(JSON.parse(parsed.request_json));
  if (
    request.actionId !== parsed.action_id ||
    request.operationId !== parsed.operation_id ||
    request.dispatchId !== parsed.dispatch_id ||
    request.executionAttemptId !== parsed.execution_attempt_id ||
    request.kind !== parsed.kind
  ) {
    throw new Error("remote_action_row_identity_mismatch");
  }
  const serialized = serializeRequest(request);
  if (
    serialized.json !== parsed.request_json ||
    serialized.fingerprint !== parsed.request_fingerprint
  ) {
    throw new Error("remote_action_row_payload_mismatch");
  }
  return {
    request,
    requestFingerprint: parsed.request_fingerprint,
    state: parsed.state,
    createdAt: parsed.created_at,
    deliveredAt: parsed.delivered_at ?? undefined,
    acknowledgedAt: parsed.acknowledged_at ?? undefined,
    settledAt: parsed.settled_at ?? undefined,
    rejectedAt: parsed.rejected_at ?? undefined,
    rejectionCode: parsed.rejection_code ?? undefined
  };
}

export class RemoteExecutionActionRejectedError extends Error {
  constructor(
    readonly code: RemoteExecutionActionRejectionCode,
    options?: ErrorOptions
  ) {
    super(code, options);
    this.name = "RemoteExecutionActionRejectedError";
  }
}

export class RemoteExecutionActionRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date()
  ) {}

  record(rawRequest: unknown): RemoteExecutionActionRecord {
    const request = remoteExecutionActionRequestSchema.parse(rawRequest);
    const serialized = serializeRequest(request);
    return inWriteTransaction(this.database, () => {
      const existing = this.get(request.actionId);
      if (existing) {
        if (
          existing.requestFingerprint !== serialized.fingerprint ||
          JSON.stringify(existing.request) !== serialized.json
        ) {
          throw new Error("remote_action_idempotency_conflict");
        }
        return existing;
      }
      this.database
        .prepare(
          `INSERT INTO remote_execution_actions(
            action_id,operation_id,dispatch_id,execution_attempt_id,kind,
            request_fingerprint,request_json,state,created_at
          ) VALUES (?,?,?,?,?,?,?,'recorded',?)`
        )
        .run(
          request.actionId,
          request.operationId,
          request.dispatchId,
          request.executionAttemptId,
          request.kind,
          serialized.fingerprint,
          serialized.json,
          this.clock().toISOString()
        );
      return this.getRequired(request.actionId);
    });
  }

  get(actionId: string): RemoteExecutionActionRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM remote_execution_actions WHERE action_id=?")
      .get(actionId);
    return row ? toRecord(row) : undefined;
  }

  getRequired(actionId: string): RemoteExecutionActionRecord {
    const action = this.get(actionId);
    if (!action) throw new Error("remote_action_not_found");
    return action;
  }

  transition(
    actionId: string,
    next: Exclude<RemoteExecutionActionState, "rejected">
  ): RemoteExecutionActionRecord {
    const parsedNext = remoteExecutionActionStateSchema.parse(next);
    return inWriteTransaction(this.database, () => {
      const action = this.getRequired(actionId);
      const state = nextRemoteExecutionActionState(action.state, parsedNext);
      if (state === action.state) return action;
      const now = this.clock().toISOString();
      const column =
        state === "delivered"
          ? "delivered_at"
          : state === "acknowledged"
            ? "acknowledged_at"
            : "settled_at";
      const updated = this.database
        .prepare(
          `UPDATE remote_execution_actions SET state=?,${column}=?
           WHERE action_id=? AND state=?`
        )
        .run(state, now, action.request.actionId, action.state);
      if (updated.changes !== 1) throw new Error("remote_action_state_conflict");
      return this.getRequired(action.request.actionId);
    });
  }

  reject(
    actionId: string,
    rawCode: RemoteExecutionActionRejectionCode
  ): RemoteExecutionActionRecord {
    const code = remoteExecutionActionRejectionCodeSchema.parse(rawCode);
    return inWriteTransaction(this.database, () => {
      const action = this.getRequired(actionId);
      if (action.state === "rejected") {
        if (action.rejectionCode !== code) throw new Error("remote_action_rejection_conflict");
        return action;
      }
      nextRemoteExecutionActionState(action.state, "rejected");
      const updated = this.database
        .prepare(
          `UPDATE remote_execution_actions SET state='rejected',rejected_at=?,rejection_code=?
           WHERE action_id=? AND state=?`
        )
        .run(this.clock().toISOString(), code, action.request.actionId, action.state);
      if (updated.changes !== 1) throw new Error("remote_action_state_conflict");
      return this.getRequired(action.request.actionId);
    });
  }

  listUnsettled(): RemoteExecutionActionRecord[] {
    return this.database
      .prepare(
        `SELECT * FROM remote_execution_actions
         WHERE state IN ('recorded','delivered','acknowledged') ORDER BY created_at,action_id`
      )
      .all()
      .map(toRecord);
  }

  acknowledgeMailbox(messageId: string): RemoteExecutionActionRecord | undefined {
    const action = this.get(messageId);
    if (
      !action ||
      (action.request.kind !== "cancel" && action.request.kind !== "resume_same_session")
    ) {
      return undefined;
    }
    if (action.state === "recorded") this.transition(messageId, "delivered");
    const current = this.getRequired(messageId);
    return current.state === "settled" ? current : this.transition(messageId, "acknowledged");
  }

  settleAttemptCommands(input: {
    dispatchId: string;
    executionAttemptId: string;
    kinds: readonly ("cancel" | "resume_same_session")[];
  }): RemoteExecutionActionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT action_id FROM remote_execution_actions
         WHERE dispatch_id=? AND execution_attempt_id=?
           AND state IN ('recorded','delivered','acknowledged')
         ORDER BY created_at,action_id`
      )
      .all(input.dispatchId, input.executionAttemptId);
    const settled: RemoteExecutionActionRecord[] = [];
    for (const row of rows) {
      const action = this.getRequired(String(row.action_id));
      if (input.kinds.includes(action.request.kind as "cancel" | "resume_same_session")) {
        settled.push(this.transition(action.request.actionId, "settled"));
      }
    }
    return settled;
  }
}

export interface RemoteExecutionActionApplicationPort {
  recover?(
    request: RemoteExecutionActionRequest
  ): "delivered" | "settled" | undefined | Promise<"delivered" | "settled" | undefined>;
  snapshot(
    request: RemoteExecutionActionRequest
  ): RemoteExecutionLifecycleSnapshot | Promise<RemoteExecutionLifecycleSnapshot>;
  apply(
    request: RemoteExecutionActionRequest,
    decision: RemoteExecutionActionDecision
  ): "delivered" | "settled" | Promise<"delivered" | "settled">;
  afterApply?(request: RemoteExecutionActionRequest): void | Promise<void>;
}

export class RemoteExecutionActionService {
  constructor(
    private readonly actions: RemoteExecutionActionRepository,
    private readonly application: RemoteExecutionActionApplicationPort
  ) {}

  async execute(rawRequest: unknown): Promise<RemoteExecutionActionRecord> {
    const action = this.actions.record(rawRequest);
    if (action.state === "rejected") {
      if (!action.rejectionCode) throw new Error("remote_action_row_rejection_mismatch");
      throw new RemoteExecutionActionRejectedError(action.rejectionCode);
    }
    if (action.state === "settled" || action.state === "delivered") return action;
    const recovered = await this.application.recover?.(action.request);
    if (recovered) return this.actions.transition(action.request.actionId, recovered);
    const snapshot = await this.application.snapshot(action.request);
    const decision = decideRemoteExecutionAction(action.request, snapshot);
    let next: "delivered" | "settled";
    try {
      next = await this.application.apply(action.request, decision);
    } catch (error) {
      if (error instanceof RemoteExecutionActionRejectedError) {
        this.actions.reject(action.request.actionId, error.code);
      }
      throw error;
    }
    await this.application.afterApply?.(action.request);
    return this.actions.transition(action.request.actionId, next);
  }

  acknowledge(actionId: string): RemoteExecutionActionRecord {
    return this.actions.transition(actionId, "acknowledged");
  }

  settle(actionId: string): RemoteExecutionActionRecord {
    return this.actions.transition(actionId, "settled");
  }

  async reconcile(): Promise<RemoteExecutionActionRecord[]> {
    const reconciled: RemoteExecutionActionRecord[] = [];
    for (const action of this.actions.listUnsettled()) {
      if (action.state === "recorded") {
        reconciled.push(await this.execute(action.request));
      } else {
        reconciled.push(action);
      }
    }
    return reconciled;
  }
}
