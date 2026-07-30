import { isIP } from "node:net";

function normalizedAddress(address: string | undefined): string | null {
  if (!address) return null;
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  const normalized = normalizedAddress(address);
  if (!normalized) return false;
  return normalized === "::1" || (isIP(normalized) === 4 && normalized.startsWith("127."));
}

export function isPrivateNetworkAddress(address: string | undefined): boolean {
  const normalized = normalizedAddress(address);
  if (!normalized) return false;
  if (isLoopbackAddress(normalized)) return true;
  if (isIP(normalized) === 4) {
    const [first, second] = normalized.split(".").map(Number) as [number, number, number, number];
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }
  if (isIP(normalized) !== 6) return false;
  const lower = normalized.toLowerCase();
  return (
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    /^fe[89ab]/.test(lower.slice(0, 3))
  );
}

export function humanNetworkTransportAllowed(
  socket: { encrypted?: boolean; remoteAddress?: string },
  allowInsecureDevelopment = false
): boolean {
  return (
    socket.encrypted === true ||
    (allowInsecureDevelopment && isPrivateNetworkAddress(socket.remoteAddress))
  );
}
