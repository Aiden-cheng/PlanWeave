import type { IncomingHttpHeaders } from "node:http";

function normalizedOrigin(value: string): string | undefined {
  try {
    const origin = new URL(value);
    if (origin.protocol !== "https:" && origin.protocol !== "http:") return undefined;
    if (
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    ) {
      return undefined;
    }
    return origin.origin;
  } catch {
    return undefined;
  }
}

/**
 * Network deployments require browser WebSocket origins to be explicitly listed.
 * Loopback development does not apply this policy because its listener is already
 * restricted to a literal loopback address by server config validation.
 */
export function isAllowedClientOrigin(
  headers: IncomingHttpHeaders,
  allowedClientOrigins: readonly string[] | undefined
): boolean {
  if (!allowedClientOrigins) return true;
  const header = headers.origin;
  if (!header || Array.isArray(header)) return false;
  const origin = normalizedOrigin(header);
  return (
    origin !== undefined &&
    allowedClientOrigins.some((allowed) => normalizedOrigin(allowed) === origin)
  );
}
