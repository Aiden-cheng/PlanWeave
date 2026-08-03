import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const rootPackage = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
const packages = [
  "@planweave-ai/agent-host-protocol",
  "@planweave-ai/collaboration-protocol",
  "@planweave-ai/runtime",
  "@planweave-ai/server",
  "@planweave-ai/agent-host"
];
const packageDirectories = new Map([
  ["@planweave-ai/agent-host-protocol", "packages/agent-host-protocol"],
  ["@planweave-ai/collaboration-protocol", "packages/collaboration-protocol"],
  ["@planweave-ai/runtime", "packages/runtime"],
  ["@planweave-ai/server", "packages/server"],
  ["@planweave-ai/agent-host", "packages/agent-host"]
]);
const packageImportSpecifiers = new Map([
  ["@planweave-ai/agent-host-protocol", ["@planweave-ai/agent-host-protocol"]],
  [
    "@planweave-ai/collaboration-protocol",
    [
      "@planweave-ai/collaboration-protocol/core/primitives",
      "@planweave-ai/collaboration-protocol/setup"
    ]
  ],
  ["@planweave-ai/runtime", ["@planweave-ai/runtime"]],
  ["@planweave-ai/server", ["@planweave-ai/server"]],
  ["@planweave-ai/agent-host", ["@planweave-ai/agent-host"]]
]);

function assertRootOrder(scriptName) {
  const script = rootPackage.scripts?.[scriptName];
  if (typeof script !== "string") throw new Error(`root_${scriptName}_script_missing`);
  const positions = packages.map((packageName) => ({
    packageName,
    index: script.indexOf(`--filter ${packageName} `)
  }));
  for (const position of positions) {
    if (position.index < 0) throw new Error(`root_${scriptName}_omits:${position.packageName}`);
  }
  const protocol = positions[0].index;
  const contracts = positions[1].index;
  const runtime = positions[2].index;
  const server = positions[3].index;
  const host = positions[4].index;
  if (
    protocol >= contracts ||
    protocol >= runtime ||
    protocol >= server ||
    protocol >= host ||
    contracts >= server ||
    runtime >= server
  ) {
    throw new Error(`root_${scriptName}_dependency_order_invalid`);
  }
}

assertRootOrder("typecheck");
assertRootOrder("build");

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
for (const packageName of packages) {
  execFileSync(pnpm, ["--filter", packageName, "build"], {
    cwd: repoRoot,
    stdio: "inherit"
  });
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await Promise.all(${JSON.stringify(packageImportSpecifiers.get(packageName))}.map((specifier) => import(specifier)));`
    ],
    {
      cwd: resolve(repoRoot, packageDirectories.get(packageName)),
      stdio: "inherit"
    }
  );
}

console.log(`Distributed package build/import matrix passed (${packages.length} packages).`);
