#!/usr/bin/env node
/**
 * Opt-in authenticated VPS / local-TLS e2e.
 *
 * Soft:  PLANWEAVE_VPS_E2E=1 node scripts/vps-authenticated-e2e.mjs --evidence /tmp/vps-e2e.json
 * Hard:  PLANWEAVE_VPS_E2E_REQUIRE=1 node scripts/vps-authenticated-e2e.mjs --require
 * Local: --profile local-tls-fixture   (default; environmentClass is clearly labeled)
 * Remote: --profile remote-vps + PLANWEAVE_VPS_E2E_CONFIG=/absolute/outside-repo.json
 *
 * Uses the built Server package entry when available; otherwise tsx on sources.
 * Never prints enrollment codes, operator tokens, PEM material, or SSH details.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distBin = join(root, "packages/server/dist/bin.js");
const args = process.argv.slice(2);

function run(command, commandArgs, env = process.env) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: "inherit"
  });
  process.exit(result.status ?? 1);
}

if (existsSync(distBin)) {
  run(process.execPath, [distBin, "vps-e2e", ...args]);
}

const tsx = join(root, "node_modules/tsx/dist/cli.mjs");
if (existsSync(tsx)) {
  run(process.execPath, [tsx, join(root, "packages/server/src/bin.ts"), "vps-e2e", ...args]);
}

console.error(
  "vps-authenticated-e2e: build packages/server (and agent-host for local-tls-fixture) first, or install tsx."
);
process.exit(2);
