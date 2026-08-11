/**
 * Secret-free sanitization for VPS e2e evidence and diagnostics.
 * Never persists endpoints, tokens, certificates/keys, or home-directory paths.
 */

const SECRET_KV =
  /\b(?:token|password|api[_-]?key|secret|authorization|enrollment(?:Code)?|bearer|pw_enroll_[A-Za-z0-9_-]+)\b\s*[:=]\s*\S+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const ENROLL_CODE = /\bpw_enroll_[A-Za-z0-9_-]+\b/g;
const HOME_PATH = /(?:\/Users\/[^/\s"'`]+|\/home\/[^/\s"'`]+|\/var\/folders\/[^\s"'`]+)/g;
const TMP_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const IPV4_PORT = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g;
const HOSTNAME_URL = /\bhttps?:\/\/[^\s"'`]+/gi;
const PEM_BEGIN = "-----BEGIN ";
const PEM_END = "-----END ";
const PEM_DELIMITER = "-----";
const MAX_PEM_LABEL_LENGTH = 64;

function isPemLabel(value: string): boolean {
  if (
    !value ||
    value.length > MAX_PEM_LABEL_LENGTH ||
    value.startsWith(" ") ||
    value.endsWith(" ")
  ) {
    return false;
  }
  let hasAlphanumeric = false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90)) {
      hasAlphanumeric = true;
      continue;
    }
    if (character !== " ") {
      return false;
    }
  }
  return hasAlphanumeric;
}

function redactPemBlocks(value: string): string {
  let cursor = 0;
  let searchFrom = 0;
  let redacted = "";
  while (searchFrom < value.length) {
    const begin = value.indexOf(PEM_BEGIN, searchFrom);
    if (begin < 0) break;
    const labelStart = begin + PEM_BEGIN.length;
    const labelEnd = value.indexOf(PEM_DELIMITER, labelStart);
    if (labelEnd < 0) break;
    const label = value.slice(labelStart, labelEnd);
    if (!isPemLabel(label)) {
      searchFrom = labelStart;
      continue;
    }
    let endSearchFrom = labelEnd + PEM_DELIMITER.length;
    let endLabelEnd = -1;
    while (endSearchFrom < value.length) {
      const end = value.indexOf(PEM_END, endSearchFrom);
      if (end < 0) break;
      const endLabelStart = end + PEM_END.length;
      const candidateEnd = value.indexOf(PEM_DELIMITER, endLabelStart);
      if (candidateEnd < 0) break;
      if (isPemLabel(value.slice(endLabelStart, candidateEnd))) {
        endLabelEnd = candidateEnd;
        break;
      }
      endSearchFrom = candidateEnd + PEM_DELIMITER.length;
    }
    if (endLabelEnd < 0) break;
    redacted += `${value.slice(cursor, begin)}[REDACTED:PEM]`;
    cursor = endLabelEnd + PEM_DELIMITER.length;
    searchFrom = cursor;
  }
  return redacted + value.slice(cursor);
}

export function redactSensitiveText(value: string): string {
  return redactPemBlocks(value)
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
