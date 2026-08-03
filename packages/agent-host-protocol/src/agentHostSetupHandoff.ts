import { z } from "zod";
import { hostEnrollmentCodeSchema } from "./agentHostCredentials.js";
import { deploymentEndpointSchema } from "./deploymentEndpoint.js";
import { opaqueIdentifierSchema } from "./identifiers.js";

export const agentHostSetupHandoffPrefix = "planweave-agent-host-setup:" as const;
export const agentHostSetupHandoffVersion = "agent-host-setup/v1" as const;

export const agentHostSetupHandoffSchema = z
  .object({
    version: z.literal(agentHostSetupHandoffVersion),
    endpoint: deploymentEndpointSchema,
    workspaceId: opaqueIdentifierSchema,
    enrollmentCode: hostEnrollmentCodeSchema,
    expiresAt: z.string().datetime(),
    display: z
      .object({
        workspaceName: z.string().trim().min(1).max(128),
        serverName: z.string().trim().min(1).max(128)
      })
      .strict()
  })
  .strict();

export type AgentHostSetupHandoff = z.infer<typeof agentHostSetupHandoffSchema>;

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

export function serializeAgentHostSetupHandoff(input: AgentHostSetupHandoff): string {
  const value = agentHostSetupHandoffSchema.parse(input);
  return `${agentHostSetupHandoffPrefix}${encodeBase64Url(JSON.stringify(value))}`;
}

export function parseAgentHostSetupHandoff(
  value: string,
  now: Date = new Date()
): AgentHostSetupHandoff {
  if (!value.startsWith(agentHostSetupHandoffPrefix)) {
    throw new Error("agent_host_setup_handoff_prefix_invalid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeBase64Url(value.slice(agentHostSetupHandoffPrefix.length)));
  } catch (error) {
    throw new Error("agent_host_setup_handoff_invalid", { cause: error });
  }
  const parsed = agentHostSetupHandoffSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error("agent_host_setup_handoff_invalid", { cause: parsed.error });
  }
  if (Date.parse(parsed.data.expiresAt) <= now.getTime()) {
    throw new Error("agent_host_setup_handoff_expired");
  }
  return parsed.data;
}
