import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const sourceRoots = {
  runtime: resolve(repoRoot, "packages", "runtime", "src"),
  server: resolve(repoRoot, "packages", "server", "src"),
  agentHost: resolve(repoRoot, "packages", "agent-host", "src"),
  protocol: resolve(repoRoot, "packages", "distributed-protocol", "src")
};
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const protocolNodeIoModules = new Set([
  "child_process",
  "cluster",
  "dgram",
  "dns",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "net",
  "process",
  "sqlite",
  "tls",
  "worker_threads"
]);

function displayPath(path) {
  return relative(repoRoot, path).split(sep).join("/") || path;
}

function importedSpecifiers(path, source) {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const imports = [];
  function record(node, specifier) {
    imports.push({
      specifier,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
    });
  }
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      record(node, node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      record(node, node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      record(node, node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return imports;
}

async function sourceFiles(root, { productionOnly = false } = {}) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      if (productionOnly && entry.name === "__tests__") continue;
      files.push(...(await sourceFiles(path, { productionOnly })));
    } else if (entry.isFile() && sourceExtensions.has(extname(path))) {
      files.push(path);
    }
  }
  return files;
}

function isPackageImport(specifier, packageName) {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

function escapesSourceRoot(path, specifier, sourceRoot) {
  if (!specifier.startsWith(".")) return false;
  const importedPath = resolve(path, "..", specifier);
  const relativePath = relative(sourceRoot, importedPath);
  return relativePath === ".." || relativePath.startsWith(`..${sep}`);
}

function importsSourceRoot(path, specifier, sourceRoot) {
  if (!specifier.startsWith(".")) return false;
  const importedPath = resolve(path, "..", specifier);
  const relativePath = relative(sourceRoot, importedPath);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== "..");
}

async function inspect(rootName, options = {}) {
  const root = sourceRoots[rootName];
  const violations = [];
  const files = await sourceFiles(root, options);
  for (const path of files) {
    const source = await readFile(path, "utf8");
    for (const imported of importedSpecifiers(path, source)) {
      let reason;
      if (rootName === "runtime") {
        if (
          isPackageImport(imported.specifier, "@planweave-ai/server") ||
          isPackageImport(imported.specifier, "@planweave-ai/agent-host")
        ) {
          reason = "Runtime imports a distributed application package";
        } else if (
          ["ws", "isomorphic-ws"].some((packageName) =>
            isPackageImport(imported.specifier, packageName)
          )
        ) {
          reason = "Runtime imports distributed WebSocket transport";
        }
      } else if (rootName === "agentHost") {
        if (isPackageImport(imported.specifier, "@planweave-ai/server")) {
          reason = "Agent Host imports Server implementation";
        } else if (importsSourceRoot(path, imported.specifier, sourceRoots.server)) {
          reason = "Agent Host imports Server implementation by relative path";
        }
      } else if (rootName === "server") {
        if (isPackageImport(imported.specifier, "@planweave-ai/agent-host")) {
          reason = "Server imports Agent Host implementation";
        } else if (importsSourceRoot(path, imported.specifier, sourceRoots.agentHost)) {
          reason = "Server imports Agent Host implementation by relative path";
        }
      } else if (rootName === "protocol") {
        if (protocolNodeIoModules.has(imported.specifier.replace(/^node:/u, ""))) {
          reason = "Distributed protocol imports Node I/O";
        } else if (
          ["@planweave-ai/runtime", "@planweave-ai/server", "@planweave-ai/agent-host"].some(
            (packageName) => isPackageImport(imported.specifier, packageName)
          )
        ) {
          reason = "Distributed protocol imports an application package";
        } else if (escapesSourceRoot(path, imported.specifier, root)) {
          reason = "Distributed protocol relative import escapes its package source root";
        }
      }
      if (reason) violations.push({ path, ...imported, reason });
    }
  }
  return { files: files.length, violations };
}

const results = await Promise.all([
  inspect("runtime"),
  inspect("server"),
  inspect("agentHost"),
  inspect("protocol", { productionOnly: true })
]);
const violations = results.flatMap((result) => result.violations);

if (violations.length > 0) {
  console.error("Distributed package boundary check failed:");
  for (const violation of violations) {
    console.error(
      `- ${displayPath(violation.path)}:${violation.line} ${violation.reason}: ${violation.specifier}`
    );
  }
  process.exit(1);
}

console.log(
  `Distributed package boundary check passed (${results.reduce(
    (total, result) => total + result.files,
    0
  )} source files scanned).`
);
