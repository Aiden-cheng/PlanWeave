#!/usr/bin/env node
/**
 * Opt-in real ACP Host-local smoke.
 *
 * Soft:  PLANWEAVE_REAL_ACP=1 node scripts/real-acp-host-smoke.mjs --evidence /tmp/real-acp.json
 * Hard:  PLANWEAVE_REAL_ACP_REQUIRE=1 node scripts/real-acp-host-smoke.mjs --require
 * Pin:   --profile codex-acp
 * List:  --list-profiles
 *
 * Uses the built Agent Host package entry when available; otherwise tsx on sources.
 * Never falls back to CLI runners. Does not print credentials.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distBin = join(root, "packages/agent-host/dist/bin.js");
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
  run(process.execPath, [distBin, "real-acp-smoke", ...args]);
}

const tsx = join(root, "node_modules/tsx/dist/cli.mjs");
if (existsSync(tsx)) {
  run(process.execPath, [
    tsx,
    join(root, "packages/agent-host/src/bin.ts"),
    "real-acp-smoke",
    ...args
  ]);
}

console.error(
  "real-acp-host-smoke: build packages/agent-host first (pnpm --dir packages/agent-host build) or install tsx."
);
process.exit(2);
