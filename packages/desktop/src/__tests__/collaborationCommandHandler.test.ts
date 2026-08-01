import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CollaborationClientError } from "../main/collaboration/collaborationErrors.js";
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
