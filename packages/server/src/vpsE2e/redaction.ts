/**
 * Secret-free sanitization for VPS e2e evidence and diagnostics.
 * Never persists endpoints, tokens, certificates/keys, or home-directory paths.
 */

const SECRET_KV =
  /\b(?:token|password|api[_-]?key|secret|authorization|enrollment(?:Code)?|bearer|pw_enroll_[A-Za-z0-9_-]+)\b\s*[:=]\s*\S+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const ENROLL_CODE = /\bpw_enroll_[A-Za-z0-9_-]+\b/g;
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g;
const HOME_PATH = /(?:\/Users\/[^/\s"'`]+|\/home\/[^/\s"'`]+|\/var\/folders\/[^\s"'`]+)/g;
const TMP_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const IPV4_PORT = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g;
const HOSTNAME_URL = /\bhttps?:\/\/[^\s"'`]+/gi;

export function redactSensitiveText(value: string): string {
  return value
    .replace(PEM_BLOCK, "[REDACTED:PEM]")
    .replace(BEARER, "Bearer [REDACTED:TOKEN]")
    .replace(ENROLL_CODE, "[REDACTED:ENROLLMENT_CODE]")
    .replace(SECRET_KV, (match) => {
      const sep = match.includes("=") ? "=" : ":";
      const key = match.split(/[:=]/, 1)[0]?.trim() ?? "secret";
      return `${key}${sep}[REDACTED:CREDENTIAL]`;
    })
    .replace(HOME_PATH, "/<redacted-home>")
    .replace(HOSTNAME_URL, "[REDACTED:URL]")
    .replace(IPV4_PORT, "[REDACTED:HOST]")
    .replace(TMP_UUID, "[REDACTED:UUID]");
}

export function redactPathForEvidence(path: string): string {
  return redactSensitiveText(path)
    .replace(/\\/g, "/")
    .replace(/^.*\/(packages|node_modules|dist)\//, "…/$1/");
}

export function digestLabel(algorithm: "sha256", hex: string): string {
  return `${algorithm}:${hex}`;
}
