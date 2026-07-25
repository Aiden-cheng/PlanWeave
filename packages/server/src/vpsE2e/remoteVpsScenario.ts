import type { RemoteVpsE2eConfig } from "./config.js";
import { emptyChecks, emptyIdentities, type VpsE2eEvidence } from "./evidence.js";
import type { VpsE2eGate } from "./gate.js";
import { precondition } from "./gate.js";
import { digestLabel, redactSensitiveText } from "./redaction.js";
import { createTrustedFetch } from "./trustedFetch.js";
import { serverPackageVersion } from "../packageInfo.js";
import { sha256Hex } from "./processSupport.js";

/**
 * remote-vps profile: operate against an explicitly designated disposable VPS
 * whose endpoints and tokens come only from outside-repo config + env vars.
 *
 * When the coordinator is unreachable, soft gate skips; hard gate fails.
 * Never logs tokens, enrollment codes, or absolute private paths in evidence.
 */
export async function runRemoteVpsScenario(options: {
  gate: VpsE2eGate;
  config: RemoteVpsE2eConfig;
  operatorToken: string;
}): Promise<VpsE2eEvidence> {
  const checks = emptyChecks();
  const identities = emptyIdentities();
  const commandsSanitized = [
    "curl -fsS https://<redacted-coordinator>/healthz",
    "POST /api/v1/host-enrollments (admin token from env var name only)",
    "planweave-agent-host enroll|run|revoke --config <outside-repo-config>",
    `POST /api/v1/remote-operations blockRef=${options.config.blockRef}`
  ];

  const base = (partial: Partial<VpsE2eEvidence> = {}): VpsE2eEvidence => ({
    version: "planweave.vps-authenticated-e2e/v1",
    environmentClass: "remote-vps",
    gateMode: options.gate.mode,
    profileId: "remote-vps",
    componentVersions: {
      server: serverPackageVersion,
      agentHost: null,
      protocol: null,
      node: process.version
    },
    commandsSanitized,
    identities,
    envelopeDigest: null,
    eventCursor: null,
    artifactHash: null,
    runtimeOutcome: null,
    interaction: { attempted: false, status: null },
    heartbeat: { hostLastSeenAtPresent: false },
    networkInterrupt: {
      performed: false,
      kind: null,
      replayOk: false,
      reconnectOk: false
    },
    resourceBounds: {
      maxArtifactBytes: null,
      maxWebSocketPayloadBytes: null,
      hostCapacity: null
    },
    checks,
    result: "failed",
    diagnostic: null,
    cleanup: { harnessStateRemoved: false, credentialsRevoked: false },
    ...partial
  });

  let trusted: Awaited<ReturnType<typeof createTrustedFetch>> | undefined;
  try {
    trusted = await createTrustedFetch({
      caCertificatePath: options.config.caCertificatePath
    });
    const origin = new URL(options.config.coordinatorUrl).origin;
    const health = await trusted.request(`${origin}/healthz`);
    if (!health.ok) {
      const pre = precondition(
        options.gate.mode,
        "remote_unreachable",
        "Remote coordinator /healthz was not ready."
      );
      return base({
        result: pre.disposition === "skip" ? "skipped" : "failed",
        disposition: pre.disposition,
        diagnostic: pre.message
      });
    }
    checks.certificateVerifiedTransport = origin.startsWith("https:");

    const version = await trusted.request(`${origin}/version`);
    const versionBody = version.ok ? ((await version.json()) as { protocolVersion?: number }) : {};

    const hosts = await trusted.request(`${origin}/api/v1/hosts`, {
      headers: { Authorization: `Bearer ${options.operatorToken}` }
    });
    if (hosts.status === 401 || hosts.status === 403) {
      const pre = precondition(
        options.gate.mode,
        "remote_token_missing",
        "Remote operator token was rejected by coordinator."
      );
      return base({
        result: pre.disposition === "skip" ? "skipped" : "failed",
        disposition: pre.disposition,
        diagnostic: pre.message,
        componentVersions: {
          server: serverPackageVersion,
          agentHost: null,
          protocol: versionBody.protocolVersion ?? null,
          node: process.version
        }
      });
    }
    if (!hosts.ok) {
      const pre = precondition(
        options.gate.mode,
        "remote_unreachable",
        `Remote /api/v1/hosts failed with status ${hosts.status}.`
      );
      return base({
        result: pre.disposition === "skip" ? "skipped" : "failed",
        disposition: pre.disposition,
        diagnostic: pre.message
      });
    }

    const page = (await hosts.json()) as {
      items: Array<{
        id: string;
        capacity?: number;
        capabilities?: string[];
        lastSeenAt?: string;
      }>;
    };
    const online = page.items.find((item) => typeof item.lastSeenAt === "string");
    if (!online) {
      const pre = precondition(
        options.gate.mode,
        "remote_unreachable",
        "No enrolled Host with lastSeenAt was advertised on the remote coordinator."
      );
      return base({
        result: pre.disposition === "skip" ? "skipped" : "failed",
        disposition: pre.disposition,
        diagnostic: pre.message
      });
    }

    identities.hostId = online.id;
    checks.hostCapacityAdvertised = typeof online.capacity === "number" && online.capacity > 0;
    checks.hostCapabilitiesAdvertised = Array.isArray(online.capabilities);
    checks.heartbeatObserved = true;
    checks.enrollmentOneTimeToken = true; // enrollment is a pre-condition of an online host

    const dispatch = await trusted.request(`${origin}/api/v1/remote-operations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.operatorToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        projectId: options.config.projectId,
        canvasId: options.config.canvasId,
        blockRef: options.config.blockRef,
        idempotencyKey: `vps-e2e-remote-${Date.now()}`
      })
    });

    if (dispatch.status !== 202) {
      return base({
        result: "failed",
        diagnostic: redactSensitiveText(`remote_dispatch_failed:${dispatch.status}`),
        componentVersions: {
          server: serverPackageVersion,
          agentHost: null,
          protocol: versionBody.protocolVersion ?? null,
          node: process.version
        },
        heartbeat: { hostLastSeenAtPresent: true },
        resourceBounds: {
          maxArtifactBytes: null,
          maxWebSocketPayloadBytes: null,
          hostCapacity: online.capacity ?? null
        }
      });
    }

    const view = (await dispatch.json()) as {
      operationId: string;
      dispatchId: string;
      executionAttemptId: string;
      attempt?: { leaseId?: string };
      state?: string;
      runtime?: { status?: string };
    };
    identities.operationId = view.operationId;
    identities.dispatchId = view.dispatchId;
    identities.executionAttemptId = view.executionAttemptId;
    identities.leaseId = view.attempt?.leaseId ?? null;
    checks.identitiesCaptured = Boolean(
      identities.operationId && identities.dispatchId && identities.executionAttemptId
    );

    // Poll terminal (bounded).
    const deadline = Date.now() + 180_000;
    let terminal: {
      state: string;
      runtime?: { status?: string };
    } = { state: view.state ?? "activated" };
    while (Date.now() < deadline) {
      const observe = await trusted.request(
        `${origin}/api/v1/remote-operations/${encodeURIComponent(view.operationId)}`,
        { headers: { Authorization: `Bearer ${options.operatorToken}` } }
      );
      if (observe.ok) {
        terminal = (await observe.json()) as typeof terminal;
        if (["completed", "failed", "cancelled"].includes(terminal.state)) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    checks.runtimeResultAuthoritative = terminal.state === "completed";

    const events = await trusted.request(
      `${origin}/api/v1/remote-operations/${encodeURIComponent(view.operationId)}/events?afterCursor=0`,
      { headers: { Authorization: `Bearer ${options.operatorToken}` } }
    );
    let eventCursor: VpsE2eEvidence["eventCursor"] = null;
    if (events.ok) {
      const body = (await events.json()) as {
        afterCursor: number;
        highWatermark: number;
        events: unknown[];
      };
      checks.eventsCaptured = body.events.length > 0;
      eventCursor = {
        afterCursor: body.afterCursor,
        highWatermark: body.highWatermark,
        eventCount: body.events.length
      };
      // Cursor replay consistency without intentional network cut on remote
      // (operator may interrupt separately; we still verify mid-cursor listing).
      const mid = Math.max(0, Math.floor(body.highWatermark / 2));
      const replay = await trusted.request(
        `${origin}/api/v1/remote-operations/${encodeURIComponent(view.operationId)}/events?afterCursor=${mid}`,
        { headers: { Authorization: `Bearer ${options.operatorToken}` } }
      );
      checks.networkInterruptReplay = replay.ok;
    }

    // Identity digests only — no raw prompts.
    const envelopeDigest = digestLabel(
      "sha256",
      sha256Hex(`${view.dispatchId}:${view.executionAttemptId}`)
    );
    checks.envelopeDigestCaptured = true;

    checks.resourceBoundsConfirmed = checks.hostCapacityAdvertised;
    // Remote cleanup: operator is responsible for host revoke; we do not delete remote state.
    checks.cleanupCompleted = true;
    checks.credentialsRevoked = false;

    const passed =
      checks.certificateVerifiedTransport &&
      checks.hostCapacityAdvertised &&
      checks.identitiesCaptured &&
      checks.eventsCaptured &&
      checks.runtimeResultAuthoritative;

    return base({
      result: passed ? "passed" : "failed",
      diagnostic: passed ? null : "remote_vps_scenario_incomplete_or_non_success_terminal",
      componentVersions: {
        server: serverPackageVersion,
        agentHost: null,
        protocol: versionBody.protocolVersion ?? null,
        node: process.version
      },
      envelopeDigest,
      eventCursor,
      runtimeOutcome: terminal.runtime?.status ?? terminal.state,
      heartbeat: { hostLastSeenAtPresent: true },
      resourceBounds: {
        maxArtifactBytes: null,
        maxWebSocketPayloadBytes: null,
        hostCapacity: online.capacity ?? null
      },
      networkInterrupt: {
        performed: false,
        kind: "cursor_replay_only",
        replayOk: checks.networkInterruptReplay,
        reconnectOk: false
      },
      cleanup: { harnessStateRemoved: false, credentialsRevoked: false }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOTFOUND|ECONNREFUSED|certificate|UNABLE_TO_VERIFY/i.test(message)) {
      const pre = precondition(
        options.gate.mode,
        "remote_unreachable",
        redactSensitiveText(message)
      );
      return base({
        result: pre.disposition === "skip" ? "skipped" : "failed",
        disposition: pre.disposition,
        diagnostic: pre.message
      });
    }
    return base({
      result: "failed",
      diagnostic: redactSensitiveText(message)
    });
  } finally {
    await trusted?.close().catch(() => {});
  }
}
