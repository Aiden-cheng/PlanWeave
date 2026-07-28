import { describe, expect, it } from "vitest";
import { isAllowedClientOrigin } from "../clientOrigin.js";

describe("network client origin policy", () => {
  const allowed = ["https://desktop.example.test/"];

  it("rejects missing, malformed, and unlisted origins when a deployment is configured", () => {
    expect(isAllowedClientOrigin({}, allowed)).toBe(false);
    expect(isAllowedClientOrigin({ origin: "https://other.example.test" }, allowed)).toBe(false);
    expect(isAllowedClientOrigin({ origin: "not-a-url" }, allowed)).toBe(false);
  });

  it("matches normalized configured origins and leaves explicit loopback development unchanged", () => {
    expect(isAllowedClientOrigin({ origin: "https://desktop.example.test" }, allowed)).toBe(true);
    expect(isAllowedClientOrigin({}, undefined)).toBe(true);
  });
});
