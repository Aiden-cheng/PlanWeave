import { describe, expect, it } from "vitest";
import { HUMAN_INVITATION_IDEMPOTENCY_KEY_MAX_LENGTH } from "../limits.js";
import { humanCreateInvitationRequestSchema } from "../identity.js";

describe("human invitation contracts", () => {
  it("accepts a bounded optional create idempotency key", () => {
    expect(
      humanCreateInvitationRequestSchema.parse({ idempotencyKey: " invitation-create-1 " })
    ).toEqual({ idempotencyKey: "invitation-create-1" });
    expect(humanCreateInvitationRequestSchema.parse({})).toEqual({});

    expect(() => humanCreateInvitationRequestSchema.parse({ idempotencyKey: " " })).toThrow();
    expect(() =>
      humanCreateInvitationRequestSchema.parse({
        idempotencyKey: "x".repeat(HUMAN_INVITATION_IDEMPOTENCY_KEY_MAX_LENGTH + 1)
      })
    ).toThrow();
  });
});
