import {
  availableRemoteAgentEndpointSchema,
  agentEndpointCapabilitiesSchema
} from "@planweave-ai/collaboration-protocol/agent-endpoint";
import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import { z } from "zod";

export const endpointAuthoritySnapshotSchema = z
  .object({
    schemaVersion: z.literal("endpoint-authority/v1"),
    controlPlane: z.enum(["collaboration", "owner"]).default("collaboration"),
    responsibilityRevision: z.number().int().nonnegative(),
    reviewerRevision: z.number().int().nonnegative()
  })
  .strict();

/** Restart-safe internal route snapshot. hostId never crosses the human projection boundary. */
export const endpointSelectionSnapshotSchema = availableRemoteAgentEndpointSchema
  .pick({
    endpointId: true,
    profileId: true,
    agentId: true,
    displayName: true,
    hostDisplayName: true,
    capabilities: true
  })
  .extend({
    schemaVersion: z.literal("endpoint-selection/v1"),
    hostId: opaqueIdentifierSchema,
    capabilities: agentEndpointCapabilitiesSchema,
    resolvedAt: z.iso.datetime(),
    authority: endpointAuthoritySnapshotSchema
  })
  .strict();

export type EndpointSelectionSnapshot = z.infer<typeof endpointSelectionSnapshotSchema>;

export function toHumanEndpointSnapshot(selection: EndpointSelectionSnapshot) {
  return availableRemoteAgentEndpointSchema
    .extend({ resolvedAt: z.iso.datetime() })
    .strict()
    .parse({
      schemaVersion: "agent-endpoint/v1",
      endpointId: selection.endpointId,
      profileId: selection.profileId,
      agentId: selection.agentId,
      displayName: selection.displayName,
      hostDisplayName: selection.hostDisplayName,
      capabilities: selection.capabilities,
      status: "available",
      resolvedAt: selection.resolvedAt
    });
}
