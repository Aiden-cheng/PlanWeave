import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { AuthorizationChangeSignal } from "../authorizationChangeSignal.js";
import {
  type HumanObserverWebSocketSendPort,
  sendHumanObserverWebSocketFrame
} from "../humanObserverWs.js";

class ControlledSendPort implements HumanObserverWebSocketSendPort {
  readonly readyState = WebSocket.OPEN;
  readonly bufferedAmount = 0;
  private sendCallback: ((error?: Error) => void) | undefined;
  private readonly listeners = {
    close: new Set<() => void>(),
    error: new Set<() => void>()
  };

  send(_data: string, callback: (error?: Error) => void): void {
    this.sendCallback = callback;
  }

  once(event: "close" | "error", listener: () => void): this {
    this.listeners[event].add(listener);
    return this;
  }

  off(event: "close" | "error", listener: () => void): this {
    this.listeners[event].delete(listener);
    return this;
  }

  emit(event: "close" | "error"): void {
    for (const listener of [...this.listeners[event]]) listener();
  }

  finishSend(error?: Error): void {
    this.sendCallback?.(error);
  }

  listenerCount(): number {
    return this.listeners.close.size + this.listeners.error.size;
  }
}

describe("human observer WebSocket frame delivery", () => {
  it("isolates authorization listener failures without failing post-commit publishers", async () => {
    const onListenerError = vi.fn();
    const signal = new AuthorizationChangeSignal(onListenerError);
    const healthyListener = vi.fn();
    signal.subscribe({ workspaceId: "w", projectId: "p" }, () => {
      throw new Error("listener failed");
    });
    signal.subscribe({ workspaceId: "w", projectId: "p" }, healthyListener);

    expect(() => signal.publish({ workspaceId: "w", projectId: "p" })).not.toThrow();
    expect(healthyListener).toHaveBeenCalledOnce();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(onListenerError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "listener failed" })
    );
  });

  it("contains async listener rejection and forwards it to the error reporter", async () => {
    const reported: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    try {
      const signal = new AuthorizationChangeSignal((error) => {
        reported.push(error);
      });
      signal.subscribe({ workspaceId: "w", projectId: "p" }, async () => {
        throw new Error("async listener failed");
      });

      signal.publish({ workspaceId: "w", projectId: "p" });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(reported).toEqual([expect.objectContaining({ message: "async listener failed" })]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("contains synchronous throws and async rejection from the error reporter", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const syncReporter = new AuthorizationChangeSignal(() => {
        throw new Error("sync reporter failed");
      });
      syncReporter.subscribe({ workspaceId: "w", projectId: "p" }, () => {
        throw new Error("listener failed");
      });
      const asyncReporter = new AuthorizationChangeSignal(async () => {
        throw new Error("async reporter failed");
      });
      asyncReporter.subscribe({ workspaceId: "w", projectId: "p" }, async () => {
        throw new Error("async listener failed");
      });

      expect(() => syncReporter.publish({ workspaceId: "w", projectId: "p" })).not.toThrow();
      expect(() => asyncReporter.publish({ workspaceId: "w", projectId: "p" })).not.toThrow();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(warning).toHaveBeenCalledTimes(2);
      expect(warning.mock.calls.map((call) => call[1])).toEqual([
        { code: "AUTHORIZATION_CHANGE_ERROR_REPORTER_FAILED" },
        { code: "AUTHORIZATION_CHANGE_ERROR_REPORTER_FAILED" }
      ]);
      expect(unhandled).toEqual([]);
    } finally {
      warning.mockRestore();
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("falls back safely when the default warning sink throws", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {
      throw new Error("warning sink failed");
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const signal = new AuthorizationChangeSignal();
      signal.subscribe({ workspaceId: "w", projectId: "p" }, () => {
        throw new Error("listener failed");
      });

      expect(() => signal.publish({ workspaceId: "w", projectId: "p" })).not.toThrow();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(stderr).toHaveBeenCalledOnce();
      expect(unhandled).toEqual([]);
    } finally {
      stderr.mockRestore();
      warning.mockRestore();
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("contains failure when both warning sinks throw", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {
      throw new Error("warning sink failed");
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw new Error("stderr sink failed");
    });
    try {
      const signal = new AuthorizationChangeSignal();
      signal.subscribe({ workspaceId: "w", projectId: "p" }, async () => {
        throw new Error("listener failed");
      });

      expect(() => signal.publish({ workspaceId: "w", projectId: "p" })).not.toThrow();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(warning).toHaveBeenCalledTimes(2);
      expect(stderr).toHaveBeenCalledOnce();
      expect(unhandled).toEqual([]);
    } finally {
      stderr.mockRestore();
      warning.mockRestore();
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("uses a fixed subscription snapshot for each published change", () => {
    const signal = new AuthorizationChangeSignal();
    const calls: string[] = [];
    let firstChange = true;
    let unsubscribeSecond = () => {};
    signal.subscribe({ workspaceId: "w", projectId: "p" }, () => {
      calls.push("first");
      if (!firstChange) return;
      firstChange = false;
      signal.subscribe({ workspaceId: "w", projectId: "p" }, () => calls.push("late"));
      unsubscribeSecond();
    });
    unsubscribeSecond = signal.subscribe({ workspaceId: "w", projectId: "p" }, () =>
      calls.push("second")
    );

    signal.publish({ workspaceId: "w", projectId: "p" });
    expect(calls).toEqual(["first", "second"]);

    signal.publish({ workspaceId: "w", projectId: "p" });
    expect(calls).toEqual(["first", "second", "first", "late"]);
  });

  it("treats repeated registration of one listener as independent subscriptions", () => {
    const signal = new AuthorizationChangeSignal();
    const listener = vi.fn();
    const unsubscribeFirst = signal.subscribe({ workspaceId: "w", projectId: "p" }, listener);
    const unsubscribeSecond = signal.subscribe({ workspaceId: "w", projectId: "p" }, listener);

    signal.publish({ workspaceId: "w", projectId: "p" });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(signal.subscriberCount()).toBe(2);

    unsubscribeFirst();
    signal.publish({ workspaceId: "w", projectId: "p" });
    expect(listener).toHaveBeenCalledTimes(3);
    expect(signal.subscriberCount()).toBe(1);

    unsubscribeSecond();
    expect(signal.subscriberCount()).toBe(0);
  });

  it("queues nested publish after the current snapshot in FIFO order", () => {
    const signal = new AuthorizationChangeSignal();
    const calls: string[] = [];
    let firstInvocation = true;
    signal.subscribe({ workspaceId: "w", projectId: "p" }, () => {
      calls.push(firstInvocation ? "first:outer" : "first:nested");
      if (!firstInvocation) return;
      firstInvocation = false;
      signal.subscribe({ workspaceId: "w", projectId: "p" }, () => calls.push("late:nested"));
      signal.publish({ workspaceId: "w", projectId: "p" });
    });
    let secondInvocation = true;
    signal.subscribe({ workspaceId: "w", projectId: "p" }, () => {
      calls.push(secondInvocation ? "second:outer" : "second:nested");
      secondInvocation = false;
    });

    signal.publish({ workspaceId: "w", projectId: "p" });

    expect(calls).toEqual([
      "first:outer",
      "second:outer",
      "first:nested",
      "second:nested",
      "late:nested"
    ]);
  });

  it.each([
    "close",
    "error"
  ] as const)("settles and removes listeners when the socket emits %s", async (event) => {
    const socket = new ControlledSendPort();
    const result = sendHumanObserverWebSocketFrame(socket, { data: "{}", bytes: 2 }, 100, 1_000);

    socket.emit(event);

    await expect(result).resolves.toBe("unavailable");
    expect(socket.listenerCount()).toBe(0);
  });

  it("settles callback errors and explicit send timeouts without leaving listeners", async () => {
    const failedSocket = new ControlledSendPort();
    const failed = sendHumanObserverWebSocketFrame(
      failedSocket,
      { data: "{}", bytes: 2 },
      100,
      1_000
    );
    failedSocket.finishSend(new Error("socket write failed"));
    await expect(failed).resolves.toBe("unavailable");
    expect(failedSocket.listenerCount()).toBe(0);

    const timedOutSocket = new ControlledSendPort();
    await expect(
      sendHumanObserverWebSocketFrame(timedOutSocket, { data: "{}", bytes: 2 }, 100, 1)
    ).resolves.toBe("timeout");
    expect(timedOutSocket.listenerCount()).toBe(0);
  });
});
