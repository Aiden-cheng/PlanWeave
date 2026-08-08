import type { createTranslator } from "../i18n";
import { formatAgentEndpointFleetCatalogError } from "./formatAgentEndpointFleetCatalogError";

export function AgentEndpointFleetCatalogHint({
  className,
  errorCode,
  t
}: {
  className?: string;
  errorCode: string | null | undefined;
  t: ReturnType<typeof createTranslator>;
}) {
  const message = formatAgentEndpointFleetCatalogError(errorCode, t);
  if (!message) return null;
  return (
    <p
      className={className ?? "text-xs text-destructive"}
      data-testid="agent-endpoint-fleet-catalog-error"
      role="alert"
    >
      {message}
    </p>
  );
}
