import { createHash } from "node:crypto";
import { canonicalizeJson } from "@planweave-ai/distributed-protocol";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";

export class HostEventInbox {
  constructor(private readonly database: SqliteDatabase) {}

  process(
    hostId: string,
    messageId: string,
    type: string,
    payload: unknown,
    action: () => void
  ): boolean {
    const requestFingerprint = createHash("sha256").update(canonicalizeJson(payload)).digest("hex");
    return inWriteTransaction(this.database, () => {
      const existing = this.database
        .prepare(
          "SELECT type,request_fingerprint FROM host_event_receipts WHERE message_id=? AND host_id=?"
        )
        .get(messageId, hostId);
      if (existing) {
        if (existing.type !== type || existing.request_fingerprint !== requestFingerprint) {
          throw new Error("host_event_message_id_reused");
        }
        return false;
      }
      action();
      this.database
        .prepare(
          "INSERT INTO host_event_receipts(message_id,host_id,type,request_fingerprint,received_at) VALUES (?,?,?,?,?)"
        )
        .run(messageId, hostId, type, requestFingerprint, new Date().toISOString());
      return true;
    });
  }
}
