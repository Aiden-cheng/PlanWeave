import { describe, expect, it } from "vitest";
import { deploymentEndpointSchema as hostEndpointSchema } from "@planweave-ai/agent-host-protocol";
import { deploymentEndpointSchema } from "../connection.js";

describe("DeploymentEndpoint package boundary", () => {
  it("reuses the Agent Host neutral endpoint schema as the single authority", () => {
    expect(deploymentEndpointSchema).toBe(hostEndpointSchema);
  });
});
