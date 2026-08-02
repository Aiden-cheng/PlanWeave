import { createHash } from "node:crypto";
import type { PlanPackageManifest } from "../types.js";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function promptPreview(markdown: string): string {
  return markdown.replace(/\s+/g, " ").trim().slice(0, 160);
}

/**
 * Content identity shared by disk-backed PlanGraph loading and in-memory canvas replicas.
 * Layout deliberately does not participate: runtime status is coupled to package content only.
 */
export function packageFingerprintFromContent(
  manifest: PlanPackageManifest,
  promptMarkdownByPath: ReadonlyMap<string, string>
): string {
  const prompts = [...promptMarkdownByPath.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return `pkg-${sha256Hex(stableJson({ manifest, prompts }))}`;
}

export function graphVersionFromPackageFingerprint(packageFingerprint: string): string {
  return `pgv-${packageFingerprint}`;
}
