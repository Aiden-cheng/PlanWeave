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
  serverEventSchema
} from "@planweave-ai/distributed-protocol";
import { describe, expect, it } from "vitest";
import {
  agentHostProtocolVersion as serverProtocolVersion,
  artifactRefSchema as serverArtifactRefSchema,
  capabilitiesSchema as serverCapabilitiesSchema,
  capabilitySchema as serverCapabilitySchema,
  dispatchFailureSchema,
  opaqueIdentifierSchema as serverOpaqueIdentifierSchema
} from "../protocol.js";

describe("Server protocol primitives", () => {
  it("re-exports shared schemas from @planweave-ai/distributed-protocol without redefining them", () => {
    expect(serverProtocolVersion).toBe(agentHostProtocolVersion);
    expect(serverOpaqueIdentifierSchema).toBe(opaqueIdentifierSchema);
    expect(serverCapabilitySchema).toBe(capabilitySchema);
    expect(serverCapabilitiesSchema).toBe(capabilitiesSchema);
    expect(serverArtifactRefSchema).toBe(artifactRefSchema);
    expect(dispatchFailureSchema).toBe(normalizedFailureSchema);
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
    expect(hostHelloSchema.parse(agentHostProtocolGoldenFixtures.hello)).toEqual(
      agentHostProtocolGoldenFixtures.hello
    );
    expect(serverEventSchema.parse(agentHostProtocolGoldenFixtures.executeDelivery)).toEqual(
      agentHostProtocolGoldenFixtures.executeDelivery
    );
    expect(serverEventSchema.parse(agentHostProtocolGoldenFixtures.resumeDelivery)).toEqual(
      agentHostProtocolGoldenFixtures.resumeDelivery
    );
    expect(hostEventSchema.parse(agentHostProtocolGoldenFixtures.acpEventBatch)).toEqual(
      agentHostProtocolGoldenFixtures.acpEventBatch
    );
    expect(hostEventSchema.parse(agentHostProtocolGoldenFixtures.interrupted)).toEqual(
      agentHostProtocolGoldenFixtures.interrupted
    );
    expect(
      interactionSettlementSchema.parse(agentHostProtocolGoldenFixtures.authenticationSettlement)
    ).toEqual(agentHostProtocolGoldenFixtures.authenticationSettlement);
  });
});
