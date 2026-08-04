import { isIP } from "node:net";
import type { ServerConfig, ServerTransport } from "./config.js";

type TransportSocket = { encrypted?: boolean; remoteAddress?: string };

export type TransportAdmissionPolicy = Readonly<{
  allowsNetworkTransport(socket: TransportSocket): boolean;
  allowsOperatorTransport(socket: TransportSocket): boolean;
  allowsLocalAdminBootstrap(socket: TransportSocket): boolean;
}>;

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
  return lower.startsWith("fc") || lower.startsWith("fd") || /^fe[89ab]/.test(lower.slice(0, 3));
}

export function createTransportAdmissionPolicyForMode(
  mode: ServerTransport["mode"]
): TransportAdmissionPolicy {
  return Object.freeze({
    allowsNetworkTransport(socket: TransportSocket): boolean {
      if (socket.encrypted === true) return true;
      if (mode === "reverse_proxy_https") return isLoopbackAddress(socket.remoteAddress);
      if (mode === "loopback_http" || mode === "lan_http") {
        return isPrivateNetworkAddress(socket.remoteAddress);
      }
      return false;
    },
    allowsOperatorTransport(socket: TransportSocket): boolean {
      if (socket.encrypted === true) return true;
      if (mode === "reverse_proxy_https" || mode === "loopback_http" || mode === "lan_http") {
        return isLoopbackAddress(socket.remoteAddress);
      }
      return false;
    },
    allowsLocalAdminBootstrap(socket: TransportSocket): boolean {
      return mode !== "reverse_proxy_https" && isLoopbackAddress(socket.remoteAddress);
    }
  });
}

export function createTransportAdmissionPolicy(config: ServerConfig): TransportAdmissionPolicy {
  return createTransportAdmissionPolicyForMode(config.transport.mode);
}

export function humanNetworkTransportAllowed(
  socket: TransportSocket,
  admission: TransportAdmissionPolicy
): boolean {
  return admission.allowsNetworkTransport(socket);
}

export function operatorNetworkTransportAllowed(
  socket: TransportSocket,
  admission: TransportAdmissionPolicy
): boolean {
  return admission.allowsOperatorTransport(socket);
}

export function localAdminBootstrapAllowed(
  socket: TransportSocket,
  admission: TransportAdmissionPolicy
): boolean {
  return admission.allowsLocalAdminBootstrap(socket);
}
