#!/usr/bin/env node

import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const allowedExtensions = new Set([".json", ".log", ".txt", ".xml"]);
const headerDefinitions = [
  { name: "proxy-authorization" },
  { name: "authorization" },
  { name: "cookie" }
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isHeaderBoundary(value) {
  return value === undefined || /[\s"'<{,;]/.test(value);
}

function quoteAt(content, index) {
  const quote = content[index];
  if (quote === '"' || quote === "'") {
    return { quote, width: 1 };
  }
  if (quote === "\\" && (content[index + 1] === '"' || content[index + 1] === "'")) {
    return { quote: content[index + 1], width: 2 };
  }
  return null;
}

function quotedValueEnd(content, start, delimiter) {
  for (let index = start + delimiter.width; index < content.length; index += 1) {
    if (content[index] === "\r" || content[index] === "\n") {
      return null;
    }
    if (delimiter.width === 1 && content[index] === "\\") {
      index += 1;
      continue;
    }
    if (
      delimiter.width === 2 &&
      content[index] === delimiter.quote &&
      content[index - 1] !== "\\" &&
      isContainerTerminator(content, index)
    ) {
      return null;
    }
    if (
      content[index] === delimiter.quote &&
      (delimiter.width === 1 || content[index - 1] === "\\")
    ) {
      return { closingStart: delimiter.width === 1 ? index : index - 1, end: index + 1 };
    }
  }
  return null;
}

function isContainerTerminator(content, index) {
  let next = index + 1;
  while (content[next] === " " || content[next] === "\t") {
    next += 1;
  }
  return content[next] === undefined || /[\r\n,}\]]/.test(content[next]);
}

function unquotedValueEnd(content, start) {
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (character === "\r" || character === "\n") {
      return index;
    }

    const delimiter = quoteAt(content, index);
    if (!delimiter) continue;
    if (delimiter.width === 1 && isContainerTerminator(content, index)) {
      return index;
    }

    const closing = quotedValueEnd(content, index, delimiter);
    if (!closing) {
      index += delimiter.width - 1;
      continue;
    }
    index = closing.end - 1;
  }
  return content.length;
}

function headerValue(content, start) {
  const delimiter = quoteAt(content, start);
  if (!delimiter) {
    return {
      contentStart: start,
      contentEnd: unquotedValueEnd(content, start)
    };
  }

  const closing = quotedValueEnd(content, start, delimiter);
  if (!closing) {
    return {
      contentStart: start + delimiter.width,
      contentEnd: unquotedValueEnd(content, start + delimiter.width)
    };
  }
  return { contentStart: start + delimiter.width, contentEnd: closing.closingStart };
}

function headerAt(content, start) {
  if (!isHeaderBoundary(content[start - 1])) return null;

  const nameDelimiter = quoteAt(content, start);
  const nameStart = start + (nameDelimiter?.width ?? 0);
  const definition = headerDefinitions.find(
    (candidate) =>
      content.slice(nameStart, nameStart + candidate.name.length).toLowerCase() === candidate.name
  );
  if (!definition) return null;

  let index = nameStart + definition.name.length;
  if (nameDelimiter) {
    const closing = content.slice(index, index + nameDelimiter.width);
    if (closing !== `${nameDelimiter.width === 2 ? "\\" : ""}${nameDelimiter.quote}`) return null;
    index += nameDelimiter.width;
  }
  while (content[index] === " " || content[index] === "\t") {
    index += 1;
  }
  if (content[index] !== ":" && content[index] !== "=") return null;
  index += 1;
  while (content[index] === " " || content[index] === "\t") {
    index += 1;
  }
  return { definition, valueStart: index };
}

function redactHeaderValues(content) {
  let result = "";
  let copiedThrough = 0;

  for (let index = 0; index < content.length; index += 1) {
    const header = headerAt(content, index);
    if (!header) continue;

    const value = headerValue(content, header.valueStart);
    if (value.contentEnd <= value.contentStart) {
      continue;
    }

    result += `${content.slice(copiedThrough, value.contentStart)}[REDACTED]`;
    copiedThrough = value.contentEnd;
    index = value.contentEnd - 1;
  }

  return result === "" ? content : `${result}${content.slice(copiedThrough)}`;
}

export function redactCiText(content, sensitivePaths = []) {
  let result = content;
  const paths = new Set(
    [
      process.cwd(),
      process.env.GITHUB_WORKSPACE,
      process.env.RUNNER_TEMP,
      process.env.HOME,
      process.env.USERPROFILE,
      ...sensitivePaths
    ].filter((value) => typeof value === "string" && value.length > 1)
  );
  for (const path of [...paths].sort((left, right) => right.length - left.length)) {
    result = result.replace(new RegExp(escapeRegExp(path), "gi"), "<redacted-path>");
  }

  result = redactHeaderValues(result)
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED PEM]")
    .replace(
      /((?:^|[\s"'<{,;?&])["']?(?:authorization|cookie|descriptor|endpoint|hostname|password|secret|token)["']?\s*[:=]\s*["']?)(?!(?:\\["']|["'])?\[REDACTED\])[^\s,"'<>]+/gi,
      "$1[REDACTED]"
    )
    .replace(/(?:\/Users|\/home)\/[^/\s<>"]+\/[^\s<>"]+/g, "<redacted-user-path>")
    .replace(/[A-Za-z]:\\Users\\[^\\\s<>"]+\\[^\s<>"]+/g, "<redacted-user-path>");
  return result;
}

async function reportFiles(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await reportFiles(path)));
    } else if (entry.isFile() && allowedExtensions.has(extname(entry.name).toLowerCase())) {
      files.push(path);
    }
  }
  return files;
}

async function main(roots) {
  if (roots.length === 0) {
    throw new Error("Usage: redact-ci-test-artifacts.mjs <report-directory> [...directories]");
  }

  let fileCount = 0;
  for (const root of roots) {
    for (const path of await reportFiles(resolve(root))) {
      const content = await readFile(path, "utf8");
      await writeFile(path, redactCiText(content), "utf8");
      fileCount += 1;
    }
  }
  console.log(`Redacted ${fileCount} CI test artifact file(s).`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  await main(process.argv.slice(2));
}
