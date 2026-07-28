import { collaborationServerOriginSchema } from "@planweave-ai/collaboration-contracts";

/**
 * Electron main derives the only Origin header used by Desktop WebSockets.
 * Renderer never supplies headers, and connection profile URLs are validated first.
 */
export function derivedWebSocketOrigin(serverBaseUrl: string): string {
  return new URL(collaborationServerOriginSchema.parse(serverBaseUrl)).origin;
}
