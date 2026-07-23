import { describe, expect, it, vi } from "vitest";
import { parseHostTransportLimits } from "../transport/hostTransport.js";
import { parseReconnectBackoffOptions, reconnectDelay } from "../transport/reconnectBackoff.js";

describe("Agent Host reconnect backoff", () => {
  it("applies capped exponential equal jitter with one random sample", () => {
    const options = parseReconnectBackoffOptions({ initialDelayMs: 100, maxDelayMs: 1_000 });
    const random = vi
      .fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.999);

    expect(reconnectDelay(1, random, options)).toBe(50);
    expect(reconnectDelay(2, random, options)).toBe(150);
    expect(reconnectDelay(20, random, options)).toBe(999);
    expect(random).toHaveBeenCalledTimes(3);
  });

  it("uses bounded defaults and rejects invalid policy or entropy", () => {
    expect(parseReconnectBackoffOptions()).toEqual({
      initialDelayMs: 250,
      maxDelayMs: 30_000
    });
    expect(() =>
      parseReconnectBackoffOptions({ initialDelayMs: 2_000, maxDelayMs: 1_000 })
    ).toThrow("agent_host_reconnect_delay_range_invalid");
    expect(() => reconnectDelay(0, () => 0, parseReconnectBackoffOptions())).toThrow(
      "agent_host_reconnect_attempt_invalid"
    );
    expect(() => reconnectDelay(1, () => 1, parseReconnectBackoffOptions())).toThrow(
      "agent_host_reconnect_random_invalid"
    );
    expect(
      reconnectDelay(1, () => 0, parseReconnectBackoffOptions({ initialDelayMs: 1, maxDelayMs: 1 }))
    ).toBe(1);
  });

  it("rejects transport limits that cannot bound one validated payload", () => {
    expect(parseHostTransportLimits()).toMatchObject({
      maxPayloadBytes: 256 * 1_024,
      maxBufferedBytes: 512 * 1_024
    });
    expect(() =>
      parseHostTransportLimits({ maxPayloadBytes: 1_024, maxBufferedBytes: 512 })
    ).toThrow("agent_host_transport_buffer_smaller_than_payload");
    expect(() => parseHostTransportLimits({ maxQueuedMessages: 0 })).toThrow(
      "agent_host_transport_maxQueuedMessages_invalid"
    );
  });
});
