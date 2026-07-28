#!/usr/bin/env node
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const desktopRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repositoryRoot = resolve(desktopRoot, "../..");
const outputRoot = resolve(desktopRoot, "build/generated/planweave-self-host-server");
const imageRoot = resolve(outputRoot, "image");

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolveRun() : reject(new Error(`self-host resource build failed with exit ${code}`))
    );
  });
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(imageRoot, { recursive: true });
await run("pnpm", ["--filter", "@planweave-ai/server", "--prod", "deploy", "--legacy", resolve(imageRoot, "app")]);
await Promise.all([
  cp(resolve(desktopRoot, "build/self-host-server.Dockerfile"), resolve(imageRoot, "Dockerfile")),
  cp(resolve(repositoryRoot, "packages/server/docker-entrypoint.sh"), resolve(imageRoot, "docker-entrypoint.sh")),
  cp(resolve(desktopRoot, "build/self-host-compose.yaml"), resolve(outputRoot, "compose.yaml"))
]);
