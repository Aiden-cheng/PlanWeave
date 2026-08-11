import { describe, expect, it, vi } from "vitest";
import { createRemoteEndpointDispatchGate } from "../renderer/collaboration/remoteEndpointDispatchGate";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("remote Endpoint dispatch capacity gate", () => {
  it("waits for earlier same-Endpoint work and retries a capacity collision", async () => {
    const gate = createRemoteEndpointDispatchGate();
    const firstTerminal = deferred();
    let secondCalls = 0;

    const first = gate.run({
      endpointId: "endpoint-vps",
      execute: () => firstTerminal.promise
    });
    const second = gate.run({
      endpointId: "endpoint-vps",
      execute: async () => {
        secondCalls += 1;
        if (secondCalls === 1) throw new Error("agent_endpoint_unavailable");
      }
    });

    await vi.waitFor(() => expect(secondCalls).toBe(1));
    firstTerminal.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(secondCalls).toBe(2);
  });

  it("lets the actual reservation winner release capacity when three blocks race", async () => {
    const gate = createRemoteEndpointDispatchGate();
    const firstTerminal = deferred();
    const secondTerminal = deferred();
    let secondCalls = 0;
    let thirdCalls = 0;

    const first = gate.run({
      endpointId: "endpoint-vps",
      execute: () => firstTerminal.promise
    });
    const second = gate.run({
      endpointId: "endpoint-vps",
      execute: async () => {
        secondCalls += 1;
        if (secondCalls === 1) throw new Error("agent_endpoint_unavailable");
        await secondTerminal.promise;
      }
    });
    const third = gate.run({
      endpointId: "endpoint-vps",
      execute: async () => {
        thirdCalls += 1;
        if (thirdCalls <= 2) throw new Error("agent_endpoint_unavailable");
      }
    });

    await vi.waitFor(() => {
      expect(secondCalls).toBe(1);
      expect(thirdCalls).toBe(1);
    });
    firstTerminal.resolve();
    await vi.waitFor(() => expect(secondCalls).toBe(2));
    await vi.waitFor(() => expect(thirdCalls).toBe(2));
    secondTerminal.resolve();
    await expect(Promise.all([first, second, third])).resolves.toEqual([
      undefined,
      undefined,
      undefined
    ]);
    expect(thirdCalls).toBe(3);
  });

  it("does not deadlock when concurrent requests all observe genuine unavailability", async () => {
    const gate = createRemoteEndpointDispatchGate();
    const calls = [0, 0];
    const runs = calls.map((_, index) =>
      gate.run({
        endpointId: "endpoint-offline",
        execute: async () => {
          calls[index] = (calls[index] ?? 0) + 1;
          await Promise.resolve();
          throw new Error("agent_endpoint_unavailable");
        }
      })
    );

    const results = await Promise.allSettled(runs);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(calls.every((count) => count >= 1)).toBe(true);
  });

  it("does not hide genuine unavailability without earlier same-Endpoint work", async () => {
    const gate = createRemoteEndpointDispatchGate();

    await expect(
      gate.run({
        endpointId: "endpoint-offline",
        execute: async () => {
          throw new Error("agent_endpoint_unavailable");
        }
      })
    ).rejects.toThrow("agent_endpoint_unavailable");
  });

  it("does not serialize unrelated Endpoints", async () => {
    const gate = createRemoteEndpointDispatchGate();
    const firstTerminal = deferred();

    const first = gate.run({
      endpointId: "endpoint-a",
      execute: () => firstTerminal.promise
    });
    await expect(gate.run({ endpointId: "endpoint-b", execute: async () => "done" })).resolves.toBe(
      "done"
    );
    firstTerminal.resolve();
    await first;
  });
});
