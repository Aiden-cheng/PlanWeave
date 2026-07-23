import { ArtifactAuthorizationRepository } from "./artifactAuthorization.js";
import { AgentHostRepository } from "./hosts.js";
import { HostEventInbox } from "./hostEvents.js";
import {
  acpRecoveryIdentitySchema,
  capabilitiesSchema,
  dispatchFailureSchema,
  dispatchIdSchema,
  dispatchResultSchema,
  executionAttemptIdSchema,
  interruptionReasonSchema,
  leaseIdSchema,
  type HostEvent,
  type ProtocolDispatchFailure,
  type ProtocolDispatchResult
} from "./protocol.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";

export type DispatchStatus =
  | "leased"
  | "running"
  | "interrupted"
  | "cancelling"
  | "awaiting_writeback"
  | "completed"
  | "failed"
  | "cancelled";

export type DispatchResult = ProtocolDispatchResult;
export type DispatchFailure = ProtocolDispatchFailure;
export type DispatchInterruption = Pick<
  Extract<HostEvent, { type: "dispatch.interrupted" }>,
  "reason" | "resumable" | "recovery"
>;

export type DispatchRecord = {
  id: string;
  projectId: string;
  blockRef: string;
  packageRef: string;
  hostId: string;
  requiredCapabilities: string[];
  status: DispatchStatus;
  leaseId: string;
  executionAttemptId: string;
  leaseExpiresAt: string;
  createdAt: string;
  acceptedAt?: string;
  finishedAt?: string;
  result?: DispatchResult;
  failure?: DispatchFailure;
  interruption?: DispatchInterruption;
};

export type DispatchWriteback = {
  complete(input: {
    dispatchId: string;
    hostId: string;
    leaseId: string;
    executionAttemptId: string;
    projectId: string;
    blockRef: string;
    packageRef: string;
    result: DispatchResult;
  }): Promise<void>;
  fail(input: {
    dispatchId: string;
    hostId: string;
    leaseId: string;
    executionAttemptId: string;
    projectId: string;
    blockRef: string;
    packageRef: string;
    failure: DispatchFailure;
  }): Promise<void>;
};

export type DispatchServiceOptions = {
  leaseDurationMs: number;
  hostOfflineAfterMs: number;
  writeback: DispatchWriteback;
};

type DispatchRow = Record<string, unknown> & {
  id: string;
  project_id: string;
  block_ref: string;
  package_ref: string;
  host_id: string;
  required_capabilities_json: string;
  status: DispatchStatus;
  lease_id: string;
  execution_attempt_id: string;
  lease_expires_at: string;
  created_at: string;
  accepted_at: string | null;
  finished_at: string | null;
  result_json: string | null;
  failure_json: string | null;
  interruption_reason: DispatchInterruption["reason"] | null;
  interruption_resumable: number | null;
  interruption_recovery_json: string | null;
};

function toDispatch(row: DispatchRow): DispatchRecord {
  return {
    id: dispatchIdSchema.parse(row.id),
    projectId: row.project_id,
    blockRef: row.block_ref,
    packageRef: row.package_ref,
    hostId: row.host_id,
    requiredCapabilities: capabilitiesSchema.parse(JSON.parse(row.required_capabilities_json)),
    status: row.status,
    leaseId: leaseIdSchema.parse(row.lease_id),
    executionAttemptId: executionAttemptIdSchema.parse(row.execution_attempt_id),
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    result: row.result_json ? dispatchResultSchema.parse(JSON.parse(row.result_json)) : undefined,
    failure: row.failure_json
      ? dispatchFailureSchema.parse(JSON.parse(row.failure_json))
      : undefined,
    interruption: row.interruption_reason
      ? {
          reason: interruptionReasonSchema.parse(row.interruption_reason),
          resumable: row.interruption_resumable === 1,
          recovery: row.interruption_recovery_json
            ? acpRecoveryIdentitySchema.parse(JSON.parse(row.interruption_recovery_json))
            : undefined
        }
      : undefined
  };
}

export class DispatchService {
  private readonly inbox: HostEventInbox;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly hosts: AgentHostRepository,
    private readonly artifactAuthorization: ArtifactAuthorizationRepository,
    private readonly options: DispatchServiceOptions
  ) {
    if (!Number.isInteger(options.leaseDurationMs) || options.leaseDurationMs < 1000) {
      throw new Error("leaseDurationMs must be an integer of at least 1000.");
    }
    if (!Number.isInteger(options.hostOfflineAfterMs) || options.hostOfflineAfterMs < 1000) {
      throw new Error("hostOfflineAfterMs must be an integer of at least 1000.");
    }
    this.inbox = new HostEventInbox(database);
  }

  get(dispatchId: string): DispatchRecord | undefined {
    const row = this.database.prepare("SELECT * FROM dispatches WHERE id=?").get(dispatchId) as
      | DispatchRow
      | undefined;
    return row ? toDispatch(row) : undefined;
  }

  getRequired(dispatchId: string): DispatchRecord {
    const dispatch = this.get(dispatchId);
    if (!dispatch) throw new Error("dispatch_not_found");
    return dispatch;
  }

  accept(
    hostId: string,
    messageId: string,
    dispatchId: string,
    leaseId: string,
    executionAttemptId: string
  ): DispatchRecord {
    this.inbox.process(
      hostId,
      messageId,
      "dispatch.accepted",
      { dispatchId, leaseId, executionAttemptId },
      () => {
        const dispatch = this.requireCurrentLease(hostId, dispatchId, leaseId, executionAttemptId);
        if (dispatch.status !== "leased") {
          if (dispatch.status === "running") return;
          throw new Error("dispatch_not_awaiting_acceptance");
        }
        const acceptedAt = new Date().toISOString();
        this.database
          .prepare("UPDATE dispatches SET status='running',accepted_at=? WHERE id=?")
          .run(acceptedAt, dispatchId);
        this.appendEvent(dispatchId, "dispatch.accepted", { hostId, leaseId });
      }
    );
    return this.getRequired(dispatchId);
  }

  heartbeat(
    hostId: string,
    messageId: string,
    activeLeases: ReadonlyArray<{
      dispatchId: string;
      leaseId: string;
      executionAttemptId: string;
    }>
  ): Array<{
    dispatchId: string;
    leaseId: string;
    executionAttemptId: string;
    leaseExpiresAt: string;
  }> {
    this.inbox.process(hostId, messageId, "host.heartbeat", { activeLeases }, () => {
      const now = new Date();
      this.hosts.touch(hostId, now);
      for (const lease of activeLeases) {
        const dispatch = this.get(lease.dispatchId);
        if (
          !dispatch ||
          dispatch.hostId !== hostId ||
          dispatch.leaseId !== lease.leaseId ||
          dispatch.executionAttemptId !== lease.executionAttemptId ||
          !["leased", "running", "cancelling"].includes(dispatch.status) ||
          new Date(dispatch.leaseExpiresAt).getTime() <= now.getTime()
        ) {
          continue;
        }
        const leaseExpiresAt = new Date(now.getTime() + this.options.leaseDurationMs).toISOString();
        this.database
          .prepare("UPDATE dispatches SET lease_expires_at=? WHERE id=? AND lease_id=?")
          .run(leaseExpiresAt, dispatch.id, dispatch.leaseId);
        this.appendEvent(dispatch.id, "lease.renewed", { leaseExpiresAt });
      }
    });
    return activeLeases.flatMap((lease) => {
      const dispatch = this.get(lease.dispatchId);
      return dispatch &&
        dispatch.hostId === hostId &&
        dispatch.leaseId === lease.leaseId &&
        dispatch.executionAttemptId === lease.executionAttemptId &&
        ["leased", "running", "cancelling"].includes(dispatch.status)
        ? [
            {
              dispatchId: dispatch.id,
              leaseId: dispatch.leaseId,
              executionAttemptId: dispatch.executionAttemptId,
              leaseExpiresAt: dispatch.leaseExpiresAt
            }
          ]
        : [];
    });
  }

  recordProgress(
    hostId: string,
    messageId: string,
    input: {
      dispatchId: string;
      leaseId: string;
      executionAttemptId: string;
      percent?: number;
      message?: string;
    }
  ): void {
    this.inbox.process(hostId, messageId, "dispatch.progress", input, () => {
      const dispatch = this.requireCurrentLease(
        hostId,
        input.dispatchId,
        input.leaseId,
        input.executionAttemptId
      );
      if (dispatch.status !== "running" && dispatch.status !== "cancelling") {
        throw new Error("dispatch_not_running");
      }
      this.appendEvent(dispatch.id, "dispatch.progress", {
        percent: input.percent,
        message: input.message
      });
    });
  }

  interrupt(
    hostId: string,
    messageId: string,
    event: Extract<HostEvent, { type: "dispatch.interrupted" }>
  ): DispatchRecord {
    this.inbox.process(hostId, messageId, event.type, event, () => {
      const dispatch = this.requireCurrentLease(
        hostId,
        event.dispatchId,
        event.leaseId,
        event.executionAttemptId
      );
      if (dispatch.status === "interrupted") return;
      if (dispatch.status !== "running" && dispatch.status !== "cancelling") {
        throw new Error("dispatch_not_running");
      }
      this.database
        .prepare(
          `UPDATE dispatches
           SET status='interrupted',interruption_reason=?,interruption_resumable=?,
               interruption_recovery_json=?
           WHERE id=?`
        )
        .run(
          event.reason,
          event.resumable ? 1 : 0,
          event.recovery ? JSON.stringify(event.recovery) : null,
          dispatch.id
        );
      this.appendEvent(dispatch.id, event.type, {
        reason: event.reason,
        resumable: event.resumable,
        recovery: event.recovery
      });
    });
    return this.getRequired(event.dispatchId);
  }

  async complete(
    hostId: string,
    messageId: string,
    dispatchId: string,
    leaseId: string,
    executionAttemptId: string,
    result: DispatchResult
  ): Promise<DispatchRecord> {
    const parsedResult = dispatchResultSchema.parse(result);
    this.inbox.process(
      hostId,
      messageId,
      "dispatch.completed",
      { dispatchId, leaseId, executionAttemptId, result: parsedResult },
      () => {
        const dispatch = this.requireCurrentLease(hostId, dispatchId, leaseId, executionAttemptId);
        if (dispatch.status === "completed") return;
        if (dispatch.status !== "running" && dispatch.status !== "cancelling") {
          throw new Error("dispatch_not_running");
        }
        this.artifactAuthorization.requireResultProvenance(
          {
            projectId: dispatch.projectId,
            hostId,
            dispatchId,
            leaseId,
            executionAttemptId
          },
          parsedResult
        );
        this.database
          .prepare(
            "UPDATE dispatches SET status='awaiting_writeback',result_json=?,failure_json=NULL WHERE id=?"
          )
          .run(JSON.stringify(parsedResult), dispatchId);
        this.appendEvent(dispatchId, "dispatch.awaiting_writeback", { outcome: "completed" });
      }
    );
    return this.writeBack(dispatchId);
  }

  async fail(
    hostId: string,
    messageId: string,
    dispatchId: string,
    leaseId: string,
    executionAttemptId: string,
    failure: DispatchFailure
  ): Promise<DispatchRecord> {
    const parsedFailure = dispatchFailureSchema.parse(failure);
    this.inbox.process(
      hostId,
      messageId,
      "dispatch.failed",
      { dispatchId, leaseId, executionAttemptId, failure: parsedFailure },
      () => {
        const dispatch = this.requireCurrentLease(hostId, dispatchId, leaseId, executionAttemptId);
        if (["failed", "cancelled"].includes(dispatch.status)) return;
        if (dispatch.status !== "running" && dispatch.status !== "cancelling") {
          throw new Error("dispatch_not_running");
        }
        this.database
          .prepare(
            "UPDATE dispatches SET status='awaiting_writeback',failure_json=?,result_json=NULL WHERE id=?"
          )
          .run(JSON.stringify(parsedFailure), dispatchId);
        this.appendEvent(dispatchId, "dispatch.awaiting_writeback", { outcome: "failed" });
      }
    );
    return this.writeBack(dispatchId);
  }

  async retryPendingWritebacks(): Promise<DispatchRecord[]> {
    const rows = this.database
      .prepare(
        "SELECT id FROM dispatches WHERE status='awaiting_writeback' ORDER BY created_at ASC"
      )
      .all();
    const results: DispatchRecord[] = [];
    for (const row of rows) results.push(await this.writeBack(String(row.id)));
    return results;
  }

  async recoverExpiredLeases(now = new Date()): Promise<DispatchRecord[]> {
    const rows = this.database
      .prepare(
        `SELECT id FROM dispatches
         WHERE status IN ('leased','running','cancelling') AND lease_expires_at<=?
         ORDER BY lease_expires_at ASC`
      )
      .all(now.toISOString());
    const recovered: DispatchRecord[] = [];
    for (const row of rows) {
      const dispatchId = String(row.id);
      inWriteTransaction(this.database, () => {
        const dispatch = this.getRequired(dispatchId);
        if (
          !["leased", "running", "cancelling"].includes(dispatch.status) ||
          new Date(dispatch.leaseExpiresAt).getTime() > now.getTime()
        ) {
          return;
        }
        this.database
          .prepare(
            `UPDATE dispatches
             SET status='interrupted',interruption_reason='lease_lost',
               interruption_resumable=0,interruption_recovery_json=NULL,
               failure_json=NULL,result_json=NULL
             WHERE id=?`
          )
          .run(dispatchId);
        this.appendEvent(dispatchId, "dispatch.interrupted", {
          reason: "lease_lost",
          resumable: false,
          source: "lease_expiry"
        });
      });
      recovered.push(this.getRequired(dispatchId));
    }
    return recovered;
  }

  private requireCurrentLease(
    hostId: string,
    dispatchId: string,
    leaseId: string,
    executionAttemptId: string
  ): DispatchRecord {
    const dispatch = this.getRequired(dispatchId);
    if (
      dispatch.hostId !== hostId ||
      dispatch.leaseId !== leaseId ||
      dispatch.executionAttemptId !== executionAttemptId
    ) {
      throw new Error("lease_mismatch");
    }
    if (new Date(dispatch.leaseExpiresAt).getTime() <= Date.now()) throw new Error("lease_expired");
    return dispatch;
  }

  private async writeBack(dispatchId: string): Promise<DispatchRecord> {
    const dispatch = this.getRequired(dispatchId);
    if (dispatch.status !== "awaiting_writeback") return dispatch;
    if (dispatch.result) {
      await this.options.writeback.complete({
        dispatchId: dispatch.id,
        hostId: dispatch.hostId,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId,
        projectId: dispatch.projectId,
        blockRef: dispatch.blockRef,
        packageRef: dispatch.packageRef,
        result: dispatch.result
      });
      this.finishWriteback(dispatch, "completed");
    } else if (dispatch.failure) {
      await this.options.writeback.fail({
        dispatchId: dispatch.id,
        hostId: dispatch.hostId,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId,
        projectId: dispatch.projectId,
        blockRef: dispatch.blockRef,
        packageRef: dispatch.packageRef,
        failure: dispatch.failure
      });
      this.finishWriteback(
        dispatch,
        dispatch.failure.code === "execution_cancelled" ? "cancelled" : "failed"
      );
    } else {
      throw new Error("dispatch_writeback_payload_missing");
    }
    return this.getRequired(dispatchId);
  }

  private finishWriteback(dispatch: DispatchRecord, status: "completed" | "failed" | "cancelled") {
    inWriteTransaction(this.database, () => {
      const current = this.getRequired(dispatch.id);
      if (current.status === status) return;
      if (current.status !== "awaiting_writeback") {
        throw new Error("dispatch_writeback_state_changed");
      }
      const updated = this.database
        .prepare(
          "UPDATE dispatches SET status=?,finished_at=? WHERE id=? AND status='awaiting_writeback' AND lease_id=?"
        )
        .run(status, new Date().toISOString(), dispatch.id, dispatch.leaseId);
      if (updated.changes !== 1) throw new Error("dispatch_writeback_state_changed");
      this.appendEvent(dispatch.id, `dispatch.${status}`, {});
    });
  }

  private appendEvent(dispatchId: string, type: string, payload: Record<string, unknown>): void {
    this.database
      .prepare(
        "INSERT INTO dispatch_events(dispatch_id,type,payload_json,occurred_at) VALUES (?,?,?,?)"
      )
      .run(dispatchId, type, JSON.stringify(payload), new Date().toISOString());
  }
}
