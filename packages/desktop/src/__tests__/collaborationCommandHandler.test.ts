import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CollaborationClientError,
  collaborationConnectionErrorFromUnknown,
  collaborationErrorFromHttp
} from "../main/collaboration/collaborationErrors.js";
import { runCollaborationCommand } from "../main/collaboration/collaborationCommandHandler.js";

describe("runCollaborationCommand", () => {
  it("validates successful values at the IPC boundary", async () => {
    await expect(runCollaborationCommand(async () => "ready", z.literal("ready"))).resolves.toEqual(
      {
        ok: true,
        value: "ready"
      }
    );
  });

  it("serializes rate limits as a renderer-safe command error", async () => {
    const result = await runCollaborationCommand(async () => {
      throw new CollaborationClientError({
        kind: "rate_limited",
        code: "human_rate_limited",
        message: "human_rate_limited",
        httpStatus: 429,
        retryAfterMs: 2_000,
        retryable: true
      });
    }, z.unknown());

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "rate_limited",
        code: "human_rate_limited",
        message: "Too many collaboration requests. Try again shortly.",
        httpStatus: 429,
        retryAfterMs: 2_000,
        retryable: true
      }
    });
  });

  it("serializes invitation capacity failures without exposing the server code as message text", async () => {
    const result = await runCollaborationCommand(async () => {
      throw new CollaborationClientError({
        kind: "conflict",
        code: "human_limit_exceeded",
        message: "human_limit_exceeded",
        httpStatus: 409,
        retryable: false
      });
    }, z.unknown());

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "conflict",
        code: "human_limit_exceeded",
        message: "The open invitation limit has been reached.",
        httpStatus: 409,
        retryable: false
      }
    });
  });

  it("bounds unknown error messages instead of rejecting the IPC serializer", async () => {
    const result = await runCollaborationCommand(async () => {
      throw new Error("x".repeat(1_000));
    }, z.unknown());

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "unknown",
        code: "collaboration_unknown",
        retryable: false
      }
    });
    if (result.ok) throw new Error("expected command failure");
    expect(result.error.message).toHaveLength(512);
  });
});

describe("collaboration connection error semantics", () => {
  it("uses the validated private-network topology for unreachable network failures", () => {
    const error = collaborationConnectionErrorFromUnknown(
      new TypeError("fetch failed: getaddrinfo ENOTFOUND planweave.mesh.example"),
      "private_https"
    );

    expect(error).toMatchObject({
      kind: "offline",
      code: "PRIVATE_NETWORK_UNREACHABLE",
      retryable: true
    });
    expect(error.message).not.toContain("planweave.mesh.example");
  });

  it("does not infer private-network reachability from an unclassified network failure", () => {
    const error = collaborationConnectionErrorFromUnknown(new TypeError("fetch failed"));

    expect(error).toMatchObject({
      kind: "offline",
      code: "SERVER_UNREACHABLE",
      retryable: true
    });
  });

  it("preserves an HTTP error because receiving a response proves the Server was reached", () => {
    const error = collaborationConnectionErrorFromUnknown(
      collaborationErrorFromHttp(503, JSON.stringify({ error: "collaboration_offline" })),
      "private_https"
    );

    expect(error).toMatchObject({
      kind: "offline",
      code: "collaboration_offline",
      httpStatus: 503
    });
  });

  it("keeps reached-Server authorization failures distinct from reachability", () => {
    const forbidden = collaborationConnectionErrorFromUnknown(
      collaborationErrorFromHttp(
        403,
        JSON.stringify({ error: "human_role_insufficient", message: "internal policy detail" })
      ),
      "private_https"
    );
    const unauthorized = collaborationConnectionErrorFromUnknown(
      collaborationErrorFromHttp(401, JSON.stringify({ error: "human_unauthenticated" })),
      "private_https"
    );

    expect(forbidden).toMatchObject({
      kind: "forbidden",
      code: "WORKSPACE_FORBIDDEN",
      httpStatus: 403,
      retryable: false
    });
    expect(forbidden.message).not.toContain("internal policy detail");
    expect(unauthorized).toMatchObject({
      kind: "auth",
      code: "WORKSPACE_UNAUTHORIZED",
      httpStatus: 401,
      retryable: false
    });
  });

  it("does not claim the Server was reached for local credential failures", () => {
    const missingCredential = collaborationConnectionErrorFromUnknown(
      new CollaborationClientError({
        kind: "auth",
        code: "collaboration_credential_missing",
        retryable: false
      }),
      "private_https"
    );
    const localPolicyFailure = collaborationConnectionErrorFromUnknown(
      new CollaborationClientError({
        kind: "forbidden",
        code: "local_policy_forbidden",
        retryable: false
      }),
      "private_https"
    );

    expect(missingCredential.code).toBe("collaboration_credential_missing");
    expect(missingCredential.httpStatus).toBeUndefined();
    expect(localPolicyFailure.code).toBe("local_policy_forbidden");
    expect(localPolicyFailure.httpStatus).toBeUndefined();
  });
});
