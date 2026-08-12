#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
}

function cliVersion() {
  return JSON.parse(readFileSync(join(repoRoot, "packages/cli/package.json"), "utf8")).version;
}

function sourceRevision() {
  return run("git", ["rev-parse", "--short=8", "HEAD"], { capture: true }).trim();
}

export function renderAgentHostInstallScript(releaseId) {
  return `#!/bin/sh
set -eu

if ! command -v node >/dev/null 2>&1; then
  echo "PlanWeave Agent Host requires Node.js 22.13 or newer." >&2
  exit 1
fi

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) process.exit(1)' || {
  echo "PlanWeave Agent Host requires Node.js 22.13 or newer." >&2
  exit 1
}

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALL_ROOT=\${PLANWEAVE_INSTALL_ROOT:-"$HOME/.local/share/planweave"}
BIN_DIR=\${PLANWEAVE_BIN_DIR:-"$HOME/.local/bin"}
RELEASE_DIR="$INSTALL_ROOT/releases/${releaseId}"
CURRENT_LINK="$INSTALL_ROOT/current"

mkdir -p "$INSTALL_ROOT/releases" "$BIN_DIR"
if [ ! -e "$RELEASE_DIR" ]; then
  cp -R "$SOURCE_DIR/app" "$RELEASE_DIR"
fi
if [ ! -f "$RELEASE_DIR/dist/index.js" ]; then
  echo "PlanWeave installation is incomplete: $RELEASE_DIR" >&2
  exit 1
fi
if [ -e "$CURRENT_LINK" ] && [ ! -L "$CURRENT_LINK" ]; then
  echo "PlanWeave current path exists but is not a managed symlink: $CURRENT_LINK" >&2
  exit 1
fi

ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
ln -sfn "$CURRENT_LINK/dist/index.js" "$BIN_DIR/planweave"

echo "PlanWeave installed: $BIN_DIR/planweave"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Add $BIN_DIR to PATH before running planweave." ;;
esac
echo "Next: planweave agent-host enroll <handoff> --expose codex-acp"
`;
}

function renderBundleReadme() {
  return `PlanWeave Agent Host for Linux/VPS

Requirements:
- Node.js 22.13 or newer
- Tailscale connected to the same tailnet as PlanWeave Server
- The ACP agents you want to expose already installed and logged in on this host

Install:
  sh install.sh

Register and expose selected agents in one command:
  planweave agent-host enroll <handoff> --expose codex-acp

Multiple profiles may be selected with a comma-separated value:
  --expose codex-acp,claude-agent-acp

Agent credentials remain on this host. The one-time handoff is not stored in the bundle.
`;
}

function buildWorkspacePackages() {
  for (const packageName of [
    "@planweave-ai/agent-host-protocol",
    "@planweave-ai/collaboration-protocol",
    "@planweave-ai/runtime",
    "@planweave-ai/mcp",
    "@planweave-ai/agent-host"
  ]) {
    run("pnpm", ["--filter", packageName, "build"]);
  }
  run("pnpm", ["--filter", "@planweave-ai/cli", "build:workspace"]);
}

export function buildAgentHostBundle(options = {}) {
  const version = cliVersion();
  const revision = sourceRevision();
  const releaseId = `${version}-${revision}`;
  const outputPath = resolve(
    options.outputPath ??
      join(repoRoot, "packages/agent-host/release", `planweave-agent-host-${releaseId}.tar.gz`)
  );
  const stagingRoot = mkdtempSync(join(tmpdir(), "planweave-agent-host-bundle-"));
  const bundleRoot = join(stagingRoot, `planweave-agent-host-${releaseId}`);
  const appDir = join(bundleRoot, "app");

  try {
    if (!options.skipBuild) {
      buildWorkspacePackages();
    }
    mkdirSync(bundleRoot, { recursive: true });
    run(
      "pnpm",
      [
        "--config.node-linker=hoisted",
        "--filter",
        "@planweave-ai/cli",
        "--prod",
        "deploy",
        "--legacy",
        appDir
      ],
      { env: { ...process.env, HUSKY: "0" } }
    );
    const cliEntrypoint = join(appDir, "dist/index.js");
    if (!existsSync(cliEntrypoint)) {
      throw new Error("agent_host_bundle_cli_missing");
    }
    chmodSync(cliEntrypoint, 0o755);
    const help = run(process.execPath, [cliEntrypoint, "agent-host", "--help"], {
      capture: true
    });
    if (!help.startsWith("Usage: planweave agent-host")) {
      throw new Error("agent_host_bundle_cli_invalid");
    }

    const installPath = join(bundleRoot, "install.sh");
    writeFileSync(installPath, renderAgentHostInstallScript(releaseId), "utf8");
    chmodSync(installPath, 0o755);
    writeFileSync(join(bundleRoot, "README.txt"), renderBundleReadme(), "utf8");

    mkdirSync(dirname(outputPath), { recursive: true });
    run("tar", ["-czf", outputPath, "-C", stagingRoot, basename(bundleRoot)]);
    return { outputPath, releaseId };
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function flagValue(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const result = buildAgentHostBundle({
    outputPath: flagValue(args, "--output"),
    skipBuild: args.includes("--skip-build")
  });
  console.log(JSON.stringify(result));
}
