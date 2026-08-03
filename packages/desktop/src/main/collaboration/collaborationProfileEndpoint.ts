import {
  collaborationConnectionProfileSchema,
  deploymentEndpointSchema,
  isLoopbackHostname,
  isPrivateNetworkHostname,
  legacyCollaborationConnectionProfileSchema,
  type CollaborationConnectionProfile
} from "@planweave-ai/collaboration-protocol/connection";

export function migrateLegacyStoredCollaborationProfile(
  input: unknown
): CollaborationConnectionProfile {
  const legacy = legacyCollaborationConnectionProfileSchema.parse(input);
  const origin = new URL(legacy.serverBaseUrl);
  if (origin.protocol !== "http:" || !legacy.allowInsecureTransport) {
    throw new Error("collaboration_profile_endpoint_reconnect_required");
  }
  const topology = isLoopbackHostname(origin.hostname)
    ? "loopback_http"
    : isPrivateNetworkHostname(origin.hostname)
      ? "lan_http"
      : null;
  if (!topology) throw new Error("collaboration_profile_endpoint_reconnect_required");
  const endpoint = deploymentEndpointSchema.parse({
    topology,
    serverOrigin: legacy.serverBaseUrl,
    allowedClientOrigins: [legacy.serverBaseUrl],
    tlsTrust: "not_applicable"
  });
  return collaborationConnectionProfileSchema.parse({ ...legacy, endpoint });
}

export function assertRendererProfileNamespace(input: unknown): void {
  const candidate = input && typeof input === "object" ? Reflect.get(input, "profileId") : null;
  if (typeof candidate === "string" && candidate.startsWith("planweave-local-")) {
    throw new Error("collaboration_local_profile_namespace_reserved");
  }
}
