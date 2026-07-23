import {
  agentHostProtocolVersion,
  agentHostProtocolGoldenFixtures,
  artifactRefSchema,
  capabilitiesSchema,
  capabilitySchema,
  exampleExecutionEnvelopeDigest,
  exampleExecutionEnvelopeInput,
  parseAndHashExecutionEnvelope,
  normalizedFailureSchema,
  opaqueIdentifierSchema,
  hostEventSchema,
  hostHelloSchema,
  interactionSettlementSchema,
  serverEventSchema,
  type HostEvent as SharedHostEvent,
  type ServerEvent as SharedServerEvent
} from "@planweave-ai/distributed-protocol";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  agentHostProtocolVersion as serverProtocolVersion,
  artifactRefSchema as serverArtifactRefSchema,
  capabilitiesSchema as serverCapabilitiesSchema,
  capabilitySchema as serverCapabilitySchema,
  dispatchFailureSchema,
  hostEventSchema as serverHostEventSchema,
  opaqueIdentifierSchema as serverOpaqueIdentifierSchema,
  serverEventSchema as serverServerEventSchema,
  type HostEvent as ServerHostEvent,
  type ServerEvent as ServerServerEvent
} from "../protocol.js";

describe("Server protocol primitives", () => {
  it("re-exports shared schemas from @planweave-ai/distributed-protocol without redefining them", () => {
    expect(serverProtocolVersion).toBe(agentHostProtocolVersion);
    expect(serverOpaqueIdentifierSchema).toBe(opaqueIdentifierSchema);
    expect(serverCapabilitySchema).toBe(capabilitySchema);
    expect(serverCapabilitiesSchema).toBe(capabilitiesSchema);
    expect(serverArtifactRefSchema).toBe(artifactRefSchema);
    expect(dispatchFailureSchema).toBe(normalizedFailureSchema);
    expect(serverHostEventSchema).toBe(hostEventSchema);
    expect(serverServerEventSchema).toBe(serverEventSchema);
    expectTypeOf<ServerHostEvent>().toEqualTypeOf<SharedHostEvent>();
    expectTypeOf<ServerServerEvent>().toEqualTypeOf<SharedServerEvent>();
  });

  it("consumes the shared portable envelope fixture and locked digest", () => {
    const consumed = parseAndHashExecutionEnvelope(
      JSON.parse(JSON.stringify(exampleExecutionEnvelopeInput)) as unknown
    );

    expect(consumed.digest).toBe(exampleExecutionEnvelopeDigest);
    expect(consumed.envelope.blockRef).toBe("FND-001#B-002");
    expect(consumed.envelope.requiredCapabilities).toContain("acp.codex");
  });

  it("consumes the shared Coordinator and Agent Host golden fixtures", () => {
    const helloWire = JSON.stringify(hostHelloSchema.parse(agentHostProtocolGoldenFixtures.hello));
    expect(helloWire).toBe(JSON.stringify(agentHostProtocolGoldenFixtures.hello));
    for (const fixture of [
      agentHostProtocolGoldenFixtures.executeDelivery,
      agentHostProtocolGoldenFixtures.resumeDelivery
    ]) {
      expect(JSON.stringify(serverServerEventSchema.parse(fixture))).toBe(
        JSON.stringify(serverEventSchema.parse(fixture))
      );
    }
    for (const fixture of [
      agentHostProtocolGoldenFixtures.acpEventBatch,
      agentHostProtocolGoldenFixtures.interrupted,
      agentHostProtocolGoldenFixtures.authenticationRequired
    ]) {
      expect(JSON.stringify(serverHostEventSchema.parse(fixture))).toBe(
        JSON.stringify(hostEventSchema.parse(fixture))
      );
    }
    expect(
      interactionSettlementSchema.parse(agentHostProtocolGoldenFixtures.authenticationSettlement)
    ).toEqual(agentHostProtocolGoldenFixtures.authenticationSettlement);
  });
});
