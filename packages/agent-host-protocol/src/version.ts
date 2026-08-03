import { z } from "zod";

/**
 * Wire protocol version shared by Coordinator and Agent Host transports.
 * Bump only with an intentional, incompatible contract change.
 */
export const agentHostProtocolVersion = 1 as const;

export const agentHostProtocolVersionSchema = z.literal(agentHostProtocolVersion, {
  error: "Unsupported Agent Host protocol version."
});

export type AgentHostProtocolVersion = z.infer<typeof agentHostProtocolVersionSchema>;
