import { randomUUID } from "node:crypto";
import { AgentHostRepository } from "./hosts.js";
import { HostEventInbox } from "./hostEvents.js";
import { DurableMailbox, type MailboxMessage } from "./mailbox.js";
import { capabilitiesSchema, dispatchFailureSchema, dispatchResultSchema } from "./protocol.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";

export type DispatchStatus =
  | "leased"
  | "running"
  | "cancelling"
  | "awaiting_writeback"
  | "completed"
  | "failed"
  | "cancelled";

export type DispatchResult = { summary: string; artifactRefs: string[] };
export type DispatchFailure = { code: string; message: string; retryable: boolean };

export type DispatchRecord = {
  id: string;
  projectId: string;
  blockRef: string;
  packageRef: string;
  hostId: string;
  requiredCapabilities: string[];
  status: DispatchStatus;
  leaseId: string;
  leaseExpiresAt: string;
  createdAt: string;
  acceptedAt?: string;
  finishedAt?: string;
  result?: DispatchResult;
  failure?: DispatchFailure;
};

export type DispatchWriteback = {
  complete(input: {
    dispatchId: string;
    projectId: string;
    blockRef: string;
    packageRef: string;
    result: DispatchResult;
  }): Promise<void>;
  fail(input: {
    dispatchId: string;
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
  lease_expires_at: string;
  created_at: string;
  accepted_at: string | null;
  finished_at: string | null;
  result_json: string | null;
  failure_json: string | null;
};

function toDispatch(row: DispatchRow): DispatchRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    blockRef: row.block_ref,
    packageRef: row.package_ref,
    hostId: row.host_id,
    requiredCapabilities: capabilitiesSchema.parse(JSON.parse(row.required_capabilities_json)),
    status: row.status,
    leaseId: row.lease_id,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    result: row.result_json ? dispatchResultSchema.parse(JSON.parse(row.result_json)) : undefined,
    failure: row.failure_json
      ? dispatchFailureSchema.parse(JSON.parse(row.failure_json))
      : undefined
  };
}

export class DispatchService {
  private readonly inbox: HostEventInbox;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly hosts: AgentHostRepository,
    private readonly mailbox: DurableMailbox,
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

  dispatchBlock(input: {
    projectId: string;
    blockRef: string;
    packageRef: string;
    requiredCapabilities: readonly string[];
  }): DispatchRecord {
    const requiredCapabilities = capabilitiesSchema.parse(input.requiredCapabilities);
    let pendingMessage: MailboxMessage | undefined;
    const dispatch = inWriteTransaction(this.database, () => {
      const onlineAfter = new Date(Date.now() - this.options.hostOfflineAfterMs);
      const host = this.hosts.listAvailable(requiredCapabilities, onlineAfter)[0];
      if (!host) throw new Error("no_compatible_agent_host");
      const id = randomUUID();
      const leaseId = randomUUID();
      const createdAt = new Date().toISOString();
      const leaseExpiresAt = new Date(Date.now() + this.options.leaseDurationMs).toISOString();
      this.database
        .prepare(
          `INSERT INTO dispatches(
            id,project_id,block_ref,package_ref,host_id,required_capabilities_json,
            status,lease_id,lease_expires_at,created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          id,
          input.projectId,
          input.blockRef,
          input.packageRef,
          host.id,
          JSON.stringify(requiredCapabilities),
          "leased",
          leaseId,
          leaseExpiresAt,
          createdAt
        );
      this.appendEvent(id, "dispatch.leased", { hostId: host.id, leaseId, leaseExpiresAt });
      pendingMessage = this.mailbox.enqueue(host.id, {
        type: "execute_block",
        dispatchId: id,
        leaseId,
        leaseExpiresAt,
        projectId: input.projectId,
        blockRef: input.blockRef,
        packageRef: input.packageRef,
        requiredCapabilities
      });
      return this.getRequired(id);
    });
    if (pendingMessage) this.mailbox.publish(pendingMessage);
    return dispatch;
  }

  accept(hostId: string, messageId: string, dispatchId: string, leaseId: string): DispatchRecord {
    this.inbox.process(hostId, messageId, "dispatch.accepted", { dispatchId, leaseId }, () => {
      const dispatch = this.requireCurrentLease(hostId, dispatchId, leaseId);
      if (dispatch.status !== "leased") {
        if (dispatch.status === "running") return;
        throw new Error("dispatch_not_awaiting_acceptance");
      }
      const acceptedAt = new Date().toISOString();
      this.database
        .prepare("UPDATE dispatches SET status='running',accepted_at=? WHERE id=?")
        .run(acceptedAt, dispatchId);
      this.appendEvent(dispatchId, "dispatch.accepted", { hostId, leaseId });
    });
    return this.getRequired(dispatchId);
  }

  heartbeat(
    hostId: string,
    messageId: string,
    activeLeases: ReadonlyArray<{ dispatchId: string; leaseId: string }>
  ): Array<{ dispatchId: string; leaseId: string; leaseExpiresAt: string }> {
    this.inbox.process(hostId, messageId, "host.heartbeat", { activeLeases }, () => {
      const now = new Date();
      this.hosts.touch(hostId, now);
      for (const lease of activeLeases) {
        const dispatch = this.get(lease.dispatchId);
        if (
          !dispatch ||
          dispatch.hostId !== hostId ||
          dispatch.leaseId !== lease.leaseId ||
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
        ["leased", "running", "cancelling"].includes(dispatch.status)
        ? [
            {
              dispatchId: dispatch.id,
              leaseId: dispatch.leaseId,
              leaseExpiresAt: dispatch.leaseExpiresAt
            }
          ]
        : [];
    });
  }

  recordProgress(
    hostId: string,
    messageId: string,
    input: { dispatchId: string; leaseId: string; percent?: number; message?: string }
  ): void {
    this.inbox.process(hostId, messageId, "dispatch.progress", input, () => {
      const dispatch = this.requireCurrentLease(hostId, input.dispatchId, input.leaseId);
      if (dispatch.status !== "running" && dispatch.status !== "cancelling") {
        throw new Error("dispatch_not_running");
      }
      this.appendEvent(dispatch.id, "dispatch.progress", {
        percent: input.percent,
        message: input.message
      });
    });
  }

  async complete(
    hostId: string,
    messageId: string,
    dispatchId: string,
    leaseId: string,
    result: DispatchResult
  ): Promise<DispatchRecord> {
    const parsedResult = dispatchResultSchema.parse(result);
    this.inbox.process(
      hostId,
      messageId,
      "dispatch.completed",
      { dispatchId, leaseId, result: parsedResult },
      () => {
        const dispatch = this.requireCurrentLease(hostId, dispatchId, leaseId);
        if (dispatch.status === "completed") return;
        if (dispatch.status !== "running" && dispatch.status !== "cancelling") {
          throw new Error("dispatch_not_running");
        }
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
    failure: DispatchFailure
  ): Promise<DispatchRecord> {
    const parsedFailure = dispatchFailureSchema.parse(failure);
    this.inbox.process(
      hostId,
      messageId,
      "dispatch.failed",
      { dispatchId, leaseId, failure: parsedFailure },
      () => {
        const dispatch = this.requireCurrentLease(hostId, dispatchId, leaseId);
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

  cancel(dispatchId: string, reason: string): DispatchRecord {
    let pendingMessage: MailboxMessage | undefined;
    const dispatch = inWriteTransaction(this.database, () => {
      const current = this.getRequired(dispatchId);
      if (["completed", "failed", "cancelled"].includes(current.status)) return current;
      if (current.status === "awaiting_writeback") {
        throw new Error("dispatch_writeback_in_progress");
      }
      this.database.prepare("UPDATE dispatches SET status='cancelling' WHERE id=?").run(dispatchId);
      this.appendEvent(dispatchId, "dispatch.cancelling", { reason });
      pendingMessage = this.mailbox.enqueue(current.hostId, {
        type: "cancel_execution",
        dispatchId,
        leaseId: current.leaseId,
        reason
      });
      return this.getRequired(dispatchId);
    });
    if (pendingMessage) this.mailbox.publish(pendingMessage);
    return dispatch;
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
        const failure = dispatchFailureSchema.parse({
          code: "lease_expired",
          message: "The Agent Host stopped renewing its execution lease.",
          retryable: true
        });
        this.database
          .prepare(
            "UPDATE dispatches SET status='awaiting_writeback',failure_json=?,result_json=NULL WHERE id=?"
          )
          .run(JSON.stringify(failure), dispatchId);
        this.appendEvent(dispatchId, "dispatch.awaiting_writeback", {
          outcome: "lease_expired"
        });
      });
      recovered.push(await this.writeBack(dispatchId));
    }
    return recovered;
  }

  private requireCurrentLease(hostId: string, dispatchId: string, leaseId: string): DispatchRecord {
    const dispatch = this.getRequired(dispatchId);
    if (dispatch.hostId !== hostId || dispatch.leaseId !== leaseId) {
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
        projectId: dispatch.projectId,
        blockRef: dispatch.blockRef,
        packageRef: dispatch.packageRef,
        result: dispatch.result
      });
      this.finishWriteback(dispatch, "completed");
    } else if (dispatch.failure) {
      await this.options.writeback.fail({
        dispatchId: dispatch.id,
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
