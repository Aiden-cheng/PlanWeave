import type { ManifestBlock } from "../types.js";

export function requiredCapabilitiesForBlock(block: ManifestBlock): string[] {
  return block.type === "implementation" ? [...(block.requirements?.capabilities ?? [])] : [];
}
