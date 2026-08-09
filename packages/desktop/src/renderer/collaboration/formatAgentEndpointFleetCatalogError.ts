import type { createTranslator } from "../i18n";

type Translator = ReturnType<typeof createTranslator>;

function withPlaceholders(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, value),
    template
  );
}

const FLEET_CATALOG_ERROR_KEYS = {
  operator_credential_missing: "agentEndpointFleetCredentialMissing",
  operator_profile_not_active: "agentEndpointFleetProfileNotActive",
  operator_profile_not_found: "agentEndpointFleetProfileNotActive",
  operator_bridge_unavailable: "agentEndpointFleetBridgeUnavailable",
  operator_local_server_not_ready: "agentEndpointFleetLocalServerNotReady"
} as const;

export function formatAgentEndpointFleetCatalogError(
  code: string | null | undefined,
  t: Translator
): string | null {
  if (!code) return null;
  const key = FLEET_CATALOG_ERROR_KEYS[code as keyof typeof FLEET_CATALOG_ERROR_KEYS];
  if (key) {
    return withPlaceholders(t(key), { code });
  }
  if (
    code === "agent_endpoint_request_failed" ||
    code.startsWith("operator_") ||
    code.startsWith("http_")
  ) {
    return withPlaceholders(t("agentEndpointFleetLoadFailed"), { code });
  }
  return null;
}
