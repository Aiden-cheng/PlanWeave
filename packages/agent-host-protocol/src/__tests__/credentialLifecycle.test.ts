import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOST_CREDENTIAL_LIFETIME_DAYS,
  hostCredentialPolicySchema,
  hostCredentialRenewalStatusSchema,
  hostCredentialRotationRequestSchema,
  hostCredentialRotationResponseSchema
} from "../index.js";

describe("Host credential lifecycle contracts", () => {
  it("accepts only the supported automatic rotation periods", () => {
    expect(DEFAULT_HOST_CREDENTIAL_LIFETIME_DAYS).toBe(180);
    for (const lifetimeDays of [30, 90, 180, 365]) {
      expect(hostCredentialPolicySchema.parse({ lifetimeDays, renewal: "automatic" })).toEqual({
        lifetimeDays,
        renewal: "automatic"
      });
    }
    expect(() =>
      hostCredentialPolicySchema.parse({ lifetimeDays: 181, renewal: "automatic" })
    ).toThrow();
    expect(() =>
      hostCredentialPolicySchema.parse({ lifetimeDays: 180, renewal: "manual" })
    ).toThrow();
  });

  it("keeps credential material out of status and rotation responses", () => {
    const status = hostCredentialRenewalStatusSchema.parse({
      hostId: "host-1",
      credentialExpiresAt: "2030-06-30T00:00:00.000Z",
      policy: { lifetimeDays: 180, renewal: "automatic" },
      renewalRequestedAt: "2030-01-02T00:00:00.000Z",
      serverTime: "2030-01-02T00:00:01.000Z"
    });
    expect(JSON.stringify(status)).not.toContain("credentialToken");
    expect(
      hostCredentialRotationRequestSchema.parse({
        rotationId: "rotation-1",
        nextCredentialToken: `pw_host_${"A".repeat(43)}`
      }).rotationId
    ).toBe("rotation-1");
    const response = hostCredentialRotationResponseSchema.parse({
      hostId: "host-1",
      rotationId: "rotation-1",
      credentialExpiresAt: "2030-06-30T00:00:00.000Z"
    });
    expect(JSON.stringify(response)).not.toContain("pw_host_");
  });
});
