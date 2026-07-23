import {
  agentHostProtocolGoldenFixtures,
  hostEventSchema,
  hostHelloSchema,
  serverEventSchema,
  type HostEvent as SharedHostEvent,
  type ServerEvent as SharedServerEvent
} from "@planweave-ai/distributed-protocol";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  parseAgentHostEvent,
  parseAgentHostServerEvent,
  serializeAgentHostEvent,
  serializeAgentHostHello,
  type HostEvent,
  type ServerEvent
} from "../index.js";

function wireClone(input: unknown): unknown {
  return JSON.parse(JSON.stringify(input));
}

describe("Agent Host protocol conformance", () => {
  it("derives its public wire types from the shared protocol schemas", () => {
    expectTypeOf<HostEvent>().toEqualTypeOf<SharedHostEvent>();
    expectTypeOf<ServerEvent>().toEqualTypeOf<SharedServerEvent>();
    expectTypeOf(parseAgentHostEvent).returns.toEqualTypeOf<SharedHostEvent>();
    expectTypeOf(parseAgentHostServerEvent).returns.toEqualTypeOf<SharedServerEvent>();
  });

  it("parses the shared Coordinator fixtures with identical wire serialization", () => {
    for (const fixture of [
      agentHostProtocolGoldenFixtures.executeDelivery,
      agentHostProtocolGoldenFixtures.resumeDelivery
    ]) {
      const wireInput = wireClone(fixture);
      expect(JSON.stringify(parseAgentHostServerEvent(wireInput))).toBe(
        JSON.stringify(serverEventSchema.parse(wireInput))
      );
    }
  });

  it("serializes the shared Agent Host fixtures identically to the protocol schemas", () => {
    const helloInput = wireClone(agentHostProtocolGoldenFixtures.hello);
    expect(serializeAgentHostHello(helloInput)).toBe(
      JSON.stringify(hostHelloSchema.parse(helloInput))
    );

    for (const fixture of [
      agentHostProtocolGoldenFixtures.acpEventBatch,
      agentHostProtocolGoldenFixtures.interrupted,
      agentHostProtocolGoldenFixtures.authenticationRequired
    ]) {
      const wireInput = wireClone(fixture);
      expect(serializeAgentHostEvent(wireInput)).toBe(
        JSON.stringify(hostEventSchema.parse(wireInput))
      );
    }
  });
});
