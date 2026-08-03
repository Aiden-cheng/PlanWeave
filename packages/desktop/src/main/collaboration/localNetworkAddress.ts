import { isPrivateNetworkHostname } from "@planweave-ai/collaboration-protocol";
import { networkInterfaces } from "node:os";

export function resolveLocalCollaborationLanAddress(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && isPrivateNetworkHostname(entry.address)) {
        return entry.address;
      }
    }
  }
  return null;
}
