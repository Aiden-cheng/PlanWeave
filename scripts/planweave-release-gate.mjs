#!/usr/bin/env node
/**
 * Release-facing gate helper.
 *
 * Prints the four-tier checklist, evaluates sanitized evidence digests, and
 * optionally runs the deterministic multi-process suite.
 *
 * Soft live tiers remain opt-in via existing REAL_ACP / VPS_E2E commands.
 * This wrapper never embeds secrets. Skipped live evidence is not a pass.
 *
 * Usage:
 *   node scripts/planweave-release-gate.mjs --checklist
 *   node scripts/planweave-release-gate.mjs --run-deterministic --report /tmp/release-gate.json
 *   node scripts/planweave-release-gate.mjs \
 *     --deterministic-evidence /tmp/det.json \
 *     --real-acp-evidence /tmp/real-acp.json \
 *     --vps-evidence /tmp/vps-e2e.json \
 *     --tailnet-evidence /tmp/tailnet-e2e.json \
 *     --report /tmp/release-gate.json
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distBin = join(root, "packages/server/dist/bin.js");
const args = process.argv.slice(2);

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    stdio: "inherit"
  });
  process.exit(result.status ?? 1);
}

if (existsSync(distBin)) {
  run(process.execPath, [distBin, "release-gate", ...args]);
}

const tsx = join(root, "node_modules/tsx/dist/cli.mjs");
if (existsSync(tsx)) {
  run(process.execPath, [tsx, join(root, "packages/server/src/bin.ts"), "release-gate", ...args]);
}

console.error(
  "planweave-release-gate: build packages/server first (pnpm --dir packages/server build) or install tsx."
);
process.exit(2);
