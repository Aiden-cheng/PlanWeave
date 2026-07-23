import { randomBytes, randomUUID } from "node:crypto";
import {
  hostEnrollmentCompletedSchema,
  type HostEnrollmentCompleted,
  type HostEnrollmentRequest
} from "@planweave-ai/distributed-protocol";
import type { AgentHostConfig } from "../config/schema.js";
import type {
  ActiveHostCredential,
  PendingHostEnrollment
} from "../credentials/credentialContract.js";
import { FileHostCredentialStore } from "../credentials/fileCredentialStore.js";

export interface AgentHostEnrollmentExchange {
  exchange(request: HostEnrollmentRequest, signal?: AbortSignal): Promise<HostEnrollmentCompleted>;
}

export class AgentHostEnrollmentService {
  constructor(
    private readonly config: AgentHostConfig,
    private readonly credentials: FileHostCredentialStore,
    private readonly exchange: AgentHostEnrollmentExchange,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async enroll(
    enrollmentCode: string,
    options: { replaceExisting?: boolean; signal?: AbortSignal } = {}
  ): Promise<ActiveHostCredential> {
    const pending = {
      enrollmentAttemptId: `enroll-${randomUUID()}`,
      enrollmentCode,
      credentialToken: `pw_host_${randomBytes(32).toString("base64url")}`,
      createdAt: this.clock().toISOString()
    };
    await this.credentials.begin(pending, options.replaceExisting === true);
    return this.complete(pending, options.signal);
  }

  async resume(signal?: AbortSignal): Promise<ActiveHostCredential> {
    const pending = (await this.credentials.read())?.pending;
    if (!pending) throw new Error("agent_host_enrollment_not_pending");
    return this.complete(pending, signal);
  }

  private async complete(
    pending: PendingHostEnrollment,
    signal?: AbortSignal
  ): Promise<ActiveHostCredential> {
    const response = hostEnrollmentCompletedSchema.parse(
      await this.exchange.exchange(
        {
          type: "host.enrollment.request",
          protocolVersion: 1,
          enrollmentCode: pending.enrollmentCode,
          enrollmentAttemptId: pending.enrollmentAttemptId,
          credentialToken: pending.credentialToken,
          displayName: this.config.host.displayName,
          capabilities: this.config.host.capabilities,
          capacity: this.config.host.capacity
        },
        signal
      )
    );
    return this.credentials.promote(response, this.clock());
  }
}
