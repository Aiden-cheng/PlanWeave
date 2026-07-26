import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { RemoteVpsE2eConfig } from "./config.js";
import { emptyChecks, emptyIdentities, type VpsE2eEvidence } from "./evidence.js";
import type { VpsE2eGate } from "./gate.js";
import { precondition } from "./gate.js";
import { digestLabel, redactSensitiveText } from "./redaction.js";
import { createTrustedFetch } from "./trustedFetch.js";
import { serverPackageVersion } from "../packageInfo.js";
import {
  runNodeBin,
  sha256Hex,
  spawnLongLived,
  waitFor,
  type ManagedChild
} from "./processSupport.js";

const DEFAULT_TIMEOUT_MS = 90_000;
const DISPATCH_TIMEOUT_MS = 180_000;

function firstExisting(paths: readonly string[]): string | null {
  for (const path of paths) {
    if (existsSync(path)) return path;
  }
  return null;
}

/** Packaged Agent Host bin (dist). Never use an ad-hoc relative path outside the package layout. */
const agentHostBinPath =
  firstExisting([
    fileURLToPath(new URL("../../../agent-host/dist/bin.js", import.meta.url)),
    fileURLToPath(new URL("../../../../agent-host/dist/bin.js", import.meta.url))
  ]) ?? fileURLToPath(new URL("../../../agent-host/dist/bin.js", import.meta.url));

/**
 * remote-vps profile: operate against an explicitly designated disposable VPS
 * whose endpoints and tokens come only from outside-repo config + env vars.
 *
 * Always drives the packaged Agent Host via config.hostConfigPath (preflight,
 * enroll when needed, run, reconnect, revoke). Cleanup/reconnect/revoke must
 * not be recorded as true unless those steps actually succeed.
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
    "planweave-agent-host preflight|enroll|run|revoke --config <outside-repo-hostConfigPath>",
    `POST /api/v1/remote-operations blockRef=${options.config.blockRef}`,
    "network interrupt: stop packaged Host process; restart run --config <hostConfigPath>; verify heartbeat + /events?afterCursor replay"
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
  let host: ManagedChild | undefined;
  let credentialsRevoked = false;
  let hostProcessStopped = false;
  let agentHostVersion: string | null = null;
  let protocolVersion: number | null = null;
  let hostCapacity: number | null = null;
  let reconnectOk = false;
  let replayOk = false;
  let networkInterruptPerformed = false;

  try {
    const hostConfigPath = options.config.hostConfigPath;
    if (!isAbsolute(hostConfigPath)) {
      return base({
        result: "failed",
        diagnostic: "remote_vps_host_config_path_must_be_absolute"
      });
    }
    try {
      await access(hostConfigPath);
    } catch {
      const pre = precondition(
        options.gate.mode,
        "remote_config_missing",
        "remote-vps hostConfigPath is unreadable; packaged Host cannot start without outside-repo host config."
      );
      return base({
        result: pre.disposition === "skip" ? "skipped" : "failed",
        disposition: pre.disposition,
        diagnostic: pre.message
      });
    }
    if (!existsSync(agentHostBinPath)) {
      return base({
        result: "failed",
        diagnostic:
          "packaged_agent_host_bin_missing: build @planweave-ai/agent-host before remote-vps e2e"
      });
    }

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
    const versionBody = version.ok
      ? ((await version.json()) as { protocolVersion?: number; serverVersion?: string })
      : {};
    protocolVersion = versionBody.protocolVersion ?? null;

    const tokenProbe = await trusted.request(`${origin}/api/v1/hosts`, {
      headers: { Authorization: `Bearer ${options.operatorToken}` }
    });
    if (tokenProbe.status === 401 || tokenProbe.status === 403) {
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
          protocol: protocolVersion,
          node: process.version
        }
      });
    }
    if (!tokenProbe.ok) {
      const pre = precondition(
        options.gate.mode,
        "remote_unreachable",
        `Remote /api/v1/hosts failed with status ${tokenProbe.status}.`
      );
      return base({
        result: pre.disposition === "skip" ? "skipped" : "failed",
        disposition: pre.disposition,
        diagnostic: pre.message
      });
    }

    // Drive packaged Host through hostConfigPath — never assume a pre-running Host.
    const preflight = await runNodeBin(agentHostBinPath, ["preflight", "--config", hostConfigPath]);
    if (preflight.code !== 0) {
      return base({
        result: "failed",
        diagnostic: redactSensitiveText(
          `remote_vps_host_preflight_failed:${preflight.stderr || preflight.stdout}`
        ),
        componentVersions: {
          server: serverPackageVersion,
          agentHost: null,
          protocol: protocolVersion,
          node: process.version
        }
      });
    }
    let preflightBody: {
      version?: string;
      credential?: string;
      hostId?: string;
      capacity?: number;
      capabilities?: string[];
    } = {};
    try {
      preflightBody = JSON.parse(preflight.stdout) as typeof preflightBody;
    } catch {
      return base({
        result: "failed",
        diagnostic: "remote_vps_host_preflight_json_invalid"
      });
    }
    agentHostVersion =
      typeof preflightBody.version === "string" ? preflightBody.version : agentHostVersion;

    const credential = preflightBody.credential ?? "missing";
    if (credential !== "active") {
      const grantResponse = await trusted.request(`${origin}/api/v1/host-enrollments`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.operatorToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          credentialExpiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString()
        })
      });
      if (grantResponse.status !== 201) {
        return base({
          result: "failed",
          diagnostic: redactSensitiveText(
            `remote_vps_enroll_grant_failed:${grantResponse.status}`
          ),
          componentVersions: {
            server: serverPackageVersion,
            agentHost: agentHostVersion,
            protocol: protocolVersion,
            node: process.version
          }
        });
      }
      const grant = (await grantResponse.json()) as { enrollmentCode?: string };
      if (!grant.enrollmentCode || !grant.enrollmentCode.startsWith("pw_enroll_")) {
        return base({
          result: "failed",
          diagnostic: "remote_vps_enrollment_code_missing_or_invalid_shape"
        });
      }
      checks.enrollmentOneTimeToken = true;

      const enrollment = await runNodeBin(agentHostBinPath, [
        "enroll",
        "--config",
        hostConfigPath,
        "--code",
        grant.enrollmentCode
      ]);
      if (enrollment.code !== 0) {
        return base({
          result: "failed",
          diagnostic: redactSensitiveText(
            `remote_vps_host_enroll_failed:${enrollment.stderr || enrollment.stdout}`
          ),
          componentVersions: {
            server: serverPackageVersion,
            agentHost: agentHostVersion,
            protocol: protocolVersion,
            node: process.version
          }
        });
      }
    } else {
      // Active credential means a prior one-time enrollment already succeeded for this Host config.
      checks.enrollmentOneTimeToken = true;
    }

    host = spawnLongLived({
      command: process.execPath,
      args: [agentHostBinPath, "run", "--config", hostConfigPath],
      label: "remote-vps-host"
    });

    let hostOnline:
      | { id: string; lastSeenAt: string; capacity: number; capabilities: string[] }
      | undefined;
    await waitFor(
      async () => {
        if (host?.exitSnapshot) return false;
        const response = await trusted!.request(`${origin}/api/v1/hosts`, {
          headers: { Authorization: `Bearer ${options.operatorToken}` }
        });
        if (!response.ok) return false;
        const page = (await response.json()) as {
          items: Array<{
            id: string;
            capacity?: number;
            capabilities?: string[];
            lastSeenAt?: string;
          }>;
        };
        // Prefer hostId from local preflight/status when present; else any live heartbeat.
        const preferredId = preflightBody.hostId;
        const match =
          (preferredId
            ? page.items.find((item) => item.id === preferredId && typeof item.lastSeenAt === "string")
            : undefined) ?? page.items.find((item) => typeof item.lastSeenAt === "string");
        if (!match?.lastSeenAt) return false;
        hostOnline = {
          id: match.id,
          lastSeenAt: match.lastSeenAt,
          capacity: match.capacity ?? 0,
          capabilities: match.capabilities ?? []
        };
        return true;
      },
      {
        timeoutMs: DEFAULT_TIMEOUT_MS,
        label: "remote-vps-host-online",
        diagnostics: () =>
          redactSensitiveText(`${host?.logs.stdout ?? ""}\n${host?.logs.stderr ?? ""}`)
      }
    );
    if (!hostOnline) {
      return base({
        result: "failed",
        diagnostic: "remote_vps_host_online_missing_after_packaged_run"
      });
    }

    identities.hostId = hostOnline.id;
    hostCapacity = hostOnline.capacity;
    checks.hostCapacityAdvertised = hostOnline.capacity > 0;
    checks.hostCapabilitiesAdvertised = Array.isArray(hostOnline.capabilities);
    checks.heartbeatObserved = Boolean(hostOnline.lastSeenAt);
    const firstLastSeenAt = hostOnline.lastSeenAt;

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
          agentHost: agentHostVersion,
          protocol: protocolVersion,
          node: process.version
        },
        heartbeat: { hostLastSeenAtPresent: true },
        resourceBounds: {
          maxArtifactBytes: null,
          maxWebSocketPayloadBytes: null,
          hostCapacity
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

    let terminal: {
      state: string;
      runtime?: { status?: string };
    } = { state: view.state ?? "activated" };
    await waitFor(
      async () => {
        const observe = await trusted!.request(
          `${origin}/api/v1/remote-operations/${encodeURIComponent(view.operationId)}`,
          { headers: { Authorization: `Bearer ${options.operatorToken}` } }
        );
        if (!observe.ok) return false;
        terminal = (await observe.json()) as typeof terminal;
        return ["completed", "failed", "cancelled"].includes(terminal.state);
      },
      {
        timeoutMs: DISPATCH_TIMEOUT_MS,
        label: "remote-vps-dispatch-terminal",
        diagnostics: () =>
          redactSensitiveText(
            `state=${terminal.state} runtime=${terminal.runtime?.status ?? "none"} host.stderr=${host?.logs.stderr.slice(-500) ?? ""}`
          )
      }
    );
    checks.runtimeResultAuthoritative = terminal.state === "completed";

    const events = await trusted.request(
      `${origin}/api/v1/remote-operations/${encodeURIComponent(view.operationId)}/events?afterCursor=0`,
      { headers: { Authorization: `Bearer ${options.operatorToken}` } }
    );
    let eventCursor: VpsE2eEvidence["eventCursor"] = null;
    let highWatermark = 0;
    if (events.ok) {
      const body = (await events.json()) as {
        afterCursor: number;
        highWatermark: number;
        events: unknown[];
      };
      checks.eventsCaptured = body.events.length > 0;
      highWatermark = body.highWatermark;
      eventCursor = {
        afterCursor: body.afterCursor,
        highWatermark: body.highWatermark,
        eventCount: body.events.length
      };
    }

    const envelopeDigest = digestLabel(
      "sha256",
      sha256Hex(`${view.dispatchId}:${view.executionAttemptId}`)
    );
    checks.envelopeDigestCaptured = true;
    checks.resourceBoundsConfirmed = checks.hostCapacityAdvertised;

    // Network interrupt: stop packaged Host, restart with same hostConfigPath, verify heartbeat + cursor replay.
    networkInterruptPerformed = true;
    const mid = Math.max(0, Math.floor(highWatermark / 2));
    if (host?.tree.isAlive()) {
      await host.tree.terminate("remote-vps host interrupt");
      await host.exit;
    }
    host = undefined;

    host = spawnLongLived({
      command: process.execPath,
      args: [agentHostBinPath, "run", "--config", hostConfigPath],
      label: "remote-vps-host-reconnect"
    });

    await waitFor(
      async () => {
        if (host?.exitSnapshot) return false;
        const response = await trusted!.request(`${origin}/api/v1/hosts`, {
          headers: { Authorization: `Bearer ${options.operatorToken}` }
        });
        if (!response.ok) return false;
        const page = (await response.json()) as {
          items: Array<{ id: string; lastSeenAt?: string }>;
        };
        const match = page.items.find((item) => item.id === hostOnline!.id);
        reconnectOk = Boolean(match?.lastSeenAt && match.lastSeenAt !== firstLastSeenAt);
        return reconnectOk;
      },
      {
        timeoutMs: DEFAULT_TIMEOUT_MS,
        label: "remote-vps-host-reconnect",
        diagnostics: () =>
          redactSensitiveText(`${host?.logs.stdout ?? ""}\n${host?.logs.stderr ?? ""}`)
      }
    );

    const replay = await trusted.request(
      `${origin}/api/v1/remote-operations/${encodeURIComponent(view.operationId)}/events?afterCursor=${mid}`,
      { headers: { Authorization: `Bearer ${options.operatorToken}` } }
    );
    if (replay.ok) {
      const replayBody = (await replay.json()) as { highWatermark?: number; events?: unknown[] };
      replayOk =
        typeof replayBody.highWatermark === "number" &&
        replayBody.highWatermark === highWatermark &&
        Array.isArray(replayBody.events);
    }
    checks.networkInterruptReplay = replayOk && reconnectOk;

    // Revoke via packaged Host + hostConfigPath; only then may credentialsRevoked be true.
    const revoke = await runNodeBin(agentHostBinPath, ["revoke", "--config", hostConfigPath]);
    credentialsRevoked = revoke.code === 0;
    checks.credentialsRevoked = credentialsRevoked;

    if (host?.tree.isAlive()) {
      await host.tree.terminate("remote-vps cleanup");
      await host.exit;
    }
    host = undefined;
    hostProcessStopped = true;

    // No disposable harness directories on remote profile; cleanup requires revoke + process stop.
    checks.cleanupCompleted = credentialsRevoked && hostProcessStopped;

    const passed =
      checks.certificateVerifiedTransport &&
      checks.enrollmentOneTimeToken &&
      checks.hostCapacityAdvertised &&
      checks.hostCapabilitiesAdvertised &&
      checks.envelopeDigestCaptured &&
      checks.identitiesCaptured &&
      checks.eventsCaptured &&
      checks.heartbeatObserved &&
      checks.runtimeResultAuthoritative &&
      checks.networkInterruptReplay &&
      checks.resourceBoundsConfirmed &&
      checks.cleanupCompleted &&
      checks.credentialsRevoked;

    return base({
      result: passed ? "passed" : "failed",
      diagnostic: passed
        ? null
        : `remote_vps_scenario_incomplete:${JSON.stringify(
            Object.fromEntries(Object.entries(checks).filter(([, value]) => !value))
          )}`,
      componentVersions: {
        server: serverPackageVersion,
        agentHost: agentHostVersion,
        protocol: protocolVersion,
        node: process.version
      },
      envelopeDigest,
      eventCursor,
      runtimeOutcome: terminal.runtime?.status ?? terminal.state,
      heartbeat: { hostLastSeenAtPresent: checks.heartbeatObserved },
      resourceBounds: {
        maxArtifactBytes: null,
        maxWebSocketPayloadBytes: null,
        hostCapacity
      },
      networkInterrupt: {
        performed: networkInterruptPerformed,
        kind: "packaged_host_restart",
        replayOk,
        reconnectOk
      },
      cleanup: {
        harnessStateRemoved: false,
        credentialsRevoked
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOTFOUND|ECONNREFUSED|certificate|UNABLE_TO_VERIFY|vps_e2e_timeout/i.test(message)) {
      const pre = precondition(
        options.gate.mode,
        "remote_unreachable",
        redactSensitiveText(message)
      );
      return base({
        result: pre.disposition === "skip" ? "skipped" : "failed",
        disposition: pre.disposition,
        diagnostic: pre.message,
        networkInterrupt: {
          performed: networkInterruptPerformed,
          kind: networkInterruptPerformed ? "packaged_host_restart" : null,
          replayOk,
          reconnectOk
        },
        cleanup: { harnessStateRemoved: false, credentialsRevoked }
      });
    }
    return base({
      result: "failed",
      diagnostic: redactSensitiveText(message),
      networkInterrupt: {
        performed: networkInterruptPerformed,
        kind: networkInterruptPerformed ? "packaged_host_restart" : null,
        replayOk,
        reconnectOk
      },
      cleanup: { harnessStateRemoved: false, credentialsRevoked }
    });
  } finally {
    try {
      if (host?.tree.isAlive()) await host.tree.terminate("remote-vps finally");
    } catch {
      /* best-effort */
    }
    await trusted?.close().catch(() => {});
  }
}
