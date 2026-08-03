import { describe, expect, it } from "vitest";
import type { CanvasPresenceServerMessage } from "@planweave-ai/collaboration-protocol/canvas/presence";
import {
  CanvasPresenceHub,
  CanvasPresenceHubError,
  type CanvasPresenceScope
} from "../presenceHub.js";

const scope: CanvasPresenceScope = {
  workspaceId: "workspace-1",
  projectId: "project-1",
  canvasId: "default"
};

function hubFixture() {
  let now = 0;
  let nextId = 0;
  const messages = new Map<string, CanvasPresenceServerMessage[]>();
  const hub = new CanvasPresenceHub({
    clock: () => now,
    ttlMs: 1_000,
    maxSessionsPerCanvas: 2,
    maxUpdatesPerSecond: 2,
    cleanupIntervalMs: 10_000,
    setIntervalFn: () => setInterval(() => undefined, 10_000),
    sessionId: () => `session-${++nextId}`
  });
  const connect = (humanPrincipalId: string) => {
    const received: CanvasPresenceServerMessage[] = [];
    const connected = hub.connect({
      scope,
      humanPrincipalId,
      displayName: humanPrincipalId,
      send: (message) => received.push(message)
    });
    messages.set(connected.session.identity.sessionId, received);
    return { ...connected, received };
  };
  return {
    hub,
    connect,
    messages,
    advance(ms: number) {
      now += ms;
    }
  };
}

describe("canvas presence hub", () => {
  it("keeps same-canvas snapshots and fans updates out to other sessions only", () => {
    const fixture = hubFixture();
    const first = fixture.connect("human-1");
    const second = fixture.connect("human-2");
    expect(second.snapshot).toHaveLength(1);

    fixture.hub.update(second.session.identity.sessionId, scope, { x: 10, y: 20 }, ["T-001"]);
    expect(first.received).toHaveLength(1);
    expect(first.received[0]).toMatchObject({
      type: "canvas.presence.update",
      session: { identity: { humanPrincipalId: "human-2" }, pointer: { x: 10, y: 20 } }
    });
    expect(second.received).toHaveLength(0);
    fixture.hub.close();
  });

  it("isolates scopes and rejects capacity, cross-scope, and excessive updates", () => {
    const fixture = hubFixture();
    const first = fixture.connect("human-1");
    const second = fixture.connect("human-2");
    expect(() => fixture.connect("human-3")).toThrowError(
      new CanvasPresenceHubError("capacity_exceeded")
    );
    const otherWorkspace = fixture.hub.connect({
      scope: { ...scope, workspaceId: "workspace-2" },
      humanPrincipalId: "human-3",
      displayName: "human-3",
      send: () => undefined
    });
    expect(otherWorkspace.snapshot).toEqual([]);
    expect(() =>
      fixture.hub.update(
        first.session.identity.sessionId,
        { workspaceId: "workspace-1", projectId: "project-2", canvasId: "default" },
        null,
        []
      )
    ).toThrowError(new CanvasPresenceHubError("cross_scope"));
    fixture.hub.update(first.session.identity.sessionId, scope, null, []);
    fixture.hub.update(first.session.identity.sessionId, scope, null, []);
    expect(() =>
      fixture.hub.update(first.session.identity.sessionId, scope, null, [])
    ).toThrowError(new CanvasPresenceHubError("rate_limited"));
    fixture.hub.leave(second.session.identity.sessionId);
    fixture.hub.close();
  });

  it("expires, revokes, and shuts down with leave fanout and no retained state", () => {
    const fixture = hubFixture();
    const first = fixture.connect("human-1");
    const second = fixture.connect("human-2");
    fixture.advance(1_000);
    expect(fixture.hub.cleanupExpired()).toBe(2);
    expect(
      second.received.filter((message) => message.type === "canvas.presence.leave")
    ).toHaveLength(1);
    expect(
      first.received.filter((message) => message.type === "canvas.presence.leave")
    ).toHaveLength(0);
    expect(fixture.hub.size()).toBe(0);

    const third = fixture.connect("human-3");
    const fourth = fixture.connect("human-4");
    expect(
      fixture.hub.removeWhere(({ session }) => session.identity.humanPrincipalId === "human-3")
    ).toBe(1);
    expect(fourth.received.at(-1)).toMatchObject({
      type: "canvas.presence.leave",
      sessionId: third.session.identity.sessionId
    });
    fixture.hub.close();
    expect(fixture.hub.size()).toBe(0);
  });

  it("refreshes idle sessions through liveness touches and never overwrites duplicate ids", () => {
    const fixture = hubFixture();
    const first = fixture.connect("human-1");
    const second = fixture.connect("human-2");
    fixture.advance(900);
    fixture.hub.touch(first.session.identity.sessionId);
    fixture.advance(100);
    expect(fixture.hub.cleanupExpired()).toBe(1);
    expect(fixture.hub.snapshot(scope)).toHaveLength(1);

    let calls = 0;
    const duplicateHub = new CanvasPresenceHub({
      cleanupIntervalMs: 10_000,
      setIntervalFn: () => setInterval(() => undefined, 10_000),
      sessionId: () => "same-session"
    });
    duplicateHub.connect({
      scope,
      humanPrincipalId: "human-1",
      displayName: "human-1",
      send: () => {
        calls += 1;
      }
    });
    expect(() =>
      duplicateHub.connect({
        scope,
        humanPrincipalId: "human-2",
        displayName: "human-2",
        send: () => undefined
      })
    ).toThrowError(new CanvasPresenceHubError("server_error"));
    expect(duplicateHub.size()).toBe(1);
    expect(calls).toBe(0);
    duplicateHub.close();
    fixture.hub.close();
    void second;
  });
});
