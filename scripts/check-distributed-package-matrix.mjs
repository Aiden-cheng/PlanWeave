import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const rootPackage = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
const packages = [
  "@planweave-ai/distributed-protocol",
  "@planweave-ai/runtime",
  "@planweave-ai/server",
  "@planweave-ai/agent-host"
];
const packageDirectories = new Map([
  ["@planweave-ai/distributed-protocol", "packages/distributed-protocol"],
  ["@planweave-ai/runtime", "packages/runtime"],
  ["@planweave-ai/server", "packages/server"],
  ["@planweave-ai/agent-host", "packages/agent-host"]
]);

function assertRootOrder(scriptName) {
  const script = rootPackage.scripts?.[scriptName];
  if (typeof script !== "string") throw new Error(`root_${scriptName}_script_missing`);
  const positions = packages.map((packageName) => ({
    packageName,
    index: script.indexOf(packageName)
  }));
  for (const position of positions) {
    if (position.index < 0) throw new Error(`root_${scriptName}_omits:${position.packageName}`);
  }
  const protocol = positions[0].index;
  const runtime = positions[1].index;
  const server = positions[2].index;
  if (
    protocol >= runtime ||
    protocol >= server ||
    protocol >= positions[3].index ||
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
    ["--input-type=module", "--eval", `await import(${JSON.stringify(packageName)});`],
    {
      cwd: resolve(repoRoot, packageDirectories.get(packageName)),
      stdio: "inherit"
    }
  );
}

console.log(`Distributed package build/import matrix passed (${packages.length} packages).`);
