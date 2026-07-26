import { describe, expect, it } from "vitest";
import {
  operatorEnrollmentGrantRequestSchema,
  operatorEnrollmentGrantResponseSchema,
  operatorHostPageSchema,
  operatorPageQuerySchema,
  operatorTokenSchema
} from "../index.js";

describe("operator control wire contracts", () => {
  it("bounds credentials, pagination, and Host pages", () => {
    expect(() => operatorTokenSchema.parse("short")).toThrow();
    expect(operatorTokenSchema.parse("operator_token_abcdefghijklmnopqrstuvwxyz_1234")).toContain(
      "operator_token"
    );
    expect(operatorPageQuerySchema.parse({ cursor: "10", limit: "100" })).toEqual({
      cursor: 10,
      limit: 100
    });
    expect(() => operatorPageQuerySchema.parse({ cursor: 0, limit: 101 })).toThrow();
    expect(
      operatorHostPageSchema.parse({
        items: [
          {
            id: "host-1",
            displayName: "Host",
            capabilities: [],
            capacity: 1,
            online: false
          }
        ],
        nextCursor: null
      }).items[0]?.online
    ).toBe(false);
    expect(() =>
      operatorHostPageSchema.parse({
        items: [
          {
            id: "host-1",
            displayName: "Host",
            capabilities: [],
            capacity: 1,
            unexpected: true
          }
        ],
        nextCursor: null
      })
    ).toThrow();
  });

  it("rejects malformed enrollment grant dates and extra fields", () => {
    expect(() =>
      operatorEnrollmentGrantRequestSchema.parse({
        expiresAt: "not-a-date",
        credentialExpiresAt: "2030-01-01T00:00:00.000Z"
      })
    ).toThrow();
    expect(() =>
      operatorEnrollmentGrantRequestSchema.parse({
        expiresAt: "2030-01-01T00:00:00.000Z",
        credentialExpiresAt: "2030-01-01T00:00:00.000Z",
        operatorToken: "operator_token_abcdefghijklmnopqrstuvwxyz_1234"
      })
    ).toThrow();
    expect(() =>
      operatorEnrollmentGrantResponseSchema.parse({
        enrollmentCode: "pw_enroll_one_time",
        expiresAt: "2030-01-01T00:15:00.000Z"
      })
    ).toThrow();
    expect(
      operatorEnrollmentGrantResponseSchema.parse({
        enrollmentCode: `pw_enroll_${"A".repeat(43)}`,
        expiresAt: "2030-01-01T00:15:00.000Z"
      }).enrollmentCode
    ).toBe(`pw_enroll_${"A".repeat(43)}`);
  });
});
