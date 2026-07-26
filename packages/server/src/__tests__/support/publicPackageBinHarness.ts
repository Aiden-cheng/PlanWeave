import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

type PublicPackageSpec = {
  packageRoot: string;
  binName: string;
};

export type IsolatedPublicPackageBins = {
  root: string;
  binPaths: Readonly<Record<string, string>>;
};

type PublicBinExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

export type RunningPublicBin = {
  child: ChildProcessWithoutNullStreams;
  result: Promise<PublicBinExit>;
  logs: { stdout: string; stderr: string };
  command: string;
  stopPromise?: Promise<void>;
};

function publicBinFailure(running: RunningPublicBin, exit: PublicBinExit): Error {
  return new Error(
    [
      `public_bin_failed:${running.command}:exit=${String(exit.code)}:signal=${String(exit.signal)}`,
      exit.error ? `error:${exit.error.message}` : "",
      `stdout:\n${running.logs.stdout}`,
      `stderr:\n${running.logs.stderr}`
    ]
      .filter(Boolean)
      .join("\n")
  );
}

function signalProcessTree(running: RunningPublicBin, signal: NodeJS.Signals): Promise<void> {
  const pid = running.child.pid;
  if (!pid) {
    return Promise.reject(new Error(`public_bin_pid_missing:${running.command}`));
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return Promise.resolve();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return Promise.resolve();
      return Promise.reject(error);
    }
  }
  return new Promise((resolveSignal, rejectSignal) => {
    const killer = spawn(
      "taskkill",
      ["/pid", String(pid), "/t", ...(signal === "SIGKILL" ? ["/f"] : [])],
      { stdio: "ignore", windowsHide: true }
    );
    killer.once("error", rejectSignal);
    killer.once("close", (code) => {
      if (code === 0 || running.child.exitCode !== null) resolveSignal();
      else rejectSignal(new Error(`public_bin_taskkill_failed:${running.command}:exit=${code}`));
    });
  });
}

async function waitForExit(
  result: Promise<PublicBinExit>,
  timeoutMs: number
): Promise<PublicBinExit | undefined> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      result,
      new Promise<undefined>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(undefined), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class PublicBinProcessRegistry {
  readonly #running = new Set<RunningPublicBin>();

  start(binPath: string, argv: readonly string[]): RunningPublicBin {
    const child = spawn(process.execPath, [binPath, ...argv], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    let resolveResult!: (exit: PublicBinExit) => void;
    const result = new Promise<PublicBinExit>((resolve) => {
      resolveResult = resolve;
    });
    const running: RunningPublicBin = {
      child,
      result,
      logs: { stdout: "", stderr: "" },
      command: [process.execPath, binPath, ...argv].join(" ")
    };
    this.#running.add(running);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      running.logs.stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      running.logs.stderr += chunk;
    });
    child.once("error", (error) => resolveResult({ code: null, signal: null, error }));
    child.once("close", (code, signal) => resolveResult({ code, signal }));
    return running;
  }

  stop(running: RunningPublicBin): Promise<void> {
    running.stopPromise ??= this.#stop(running).catch((error: unknown) => {
      running.stopPromise = undefined;
      throw error;
    });
    return running.stopPromise;
  }

  async stopAll(): Promise<void> {
    const results = await Promise.allSettled([...this.#running].map((running) => this.stop(running)));
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length > 0) {
      throw new AggregateError(errors, "public_bin_cleanup_failed");
    }
  }

  async #stop(running: RunningPublicBin): Promise<void> {
    let exit: PublicBinExit | undefined;
    try {
      exit = await waitForExit(running.result, 0);
      if (!exit) {
        await signalProcessTree(running, "SIGTERM");
        exit = await waitForExit(running.result, 5_000);
      }
      if (!exit) {
        await signalProcessTree(running, "SIGKILL");
        exit = await waitForExit(running.result, 5_000);
      }
      if (!exit) {
        throw new Error(
          `public_bin_did_not_exit:${running.command}\nstdout:\n${running.logs.stdout}\nstderr:\n${running.logs.stderr}`
        );
      }
      if (exit.error || (exit.code !== 0 && exit.signal === null)) {
        throw publicBinFailure(running, exit);
      }
    } catch (error) {
      throw new Error(
        [
          `public_bin_cleanup_failed:${running.command}`,
          `cause:${error instanceof Error ? error.message : String(error)}`,
          `stdout:\n${running.logs.stdout}`,
          `stderr:\n${running.logs.stderr}`
        ].join("\n"),
        { cause: error }
      );
    } finally {
      if (exit) this.#running.delete(running);
    }
  }
}

function resolvePublicPackageBin(packageRoot: string, binName: string): string {
  const packageJsonPath = join(packageRoot, "package.json");
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const relativeBinPath = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[binName];
  if (!relativeBinPath) {
    throw new Error(`public_bin_field_missing:${binName}`);
  }
  const absoluteBinPath = resolve(packageRoot, relativeBinPath);
  const relativeToPackage = relative(packageRoot, absoluteBinPath);
  if (relativeToPackage === ".." || relativeToPackage.startsWith(`..${sep}`)) {
    throw new Error(`public_bin_outside_package:${binName}`);
  }
  return absoluteBinPath;
}

async function runTypeScriptBuild(tsconfigPath: string): Promise<void> {
  const compilerPath = fileURLToPath(import.meta.resolve("typescript/bin/tsc"));
  await new Promise<void>((resolveBuild, rejectBuild) => {
    const child = spawn(process.execPath, [compilerPath, "-p", tsconfigPath], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectBuild);
    child.once("close", (code) => {
      if (code === 0) {
        resolveBuild();
        return;
      }
      rejectBuild(
        new Error(
          `public_bin_build_failed:${tsconfigPath}:exit=${String(code)}\nstdout:\n${stdout}\nstderr:\n${stderr}`
        )
      );
    });
  });
}

/**
 * Builds package public bins from copied source in package roots that begin without dist.
 * Only tracked source inputs are selected; workspace build output is neither read nor modified.
 */
export async function buildIsolatedPublicPackageBins(
  repositoryRoot: string,
  packages: readonly PublicPackageSpec[]
): Promise<IsolatedPublicPackageBins> {
  const root = await mkdtemp(join(tmpdir(), "planweave-public-bins-"));
  try {
    await writeFile(
      join(root, "tsconfig.json"),
      await readFile(join(repositoryRoot, "tsconfig.json"))
    );

    const stagedPackages = await Promise.all(
      packages.map(async ({ packageRoot, binName }) => {
        const packageRelativePath = relative(repositoryRoot, packageRoot);
        const stagedPackageRoot = join(root, packageRelativePath);
        await mkdir(stagedPackageRoot, { recursive: true });
        await Promise.all([
          cp(join(packageRoot, "src"), join(stagedPackageRoot, "src"), { recursive: true }),
          cp(join(packageRoot, "package.json"), join(stagedPackageRoot, "package.json")),
          cp(join(packageRoot, "tsconfig.json"), join(stagedPackageRoot, "tsconfig.json"))
        ]);
        await symlink(
          join(packageRoot, "node_modules"),
          join(stagedPackageRoot, "node_modules"),
          "dir"
        );
        const binPath = resolvePublicPackageBin(stagedPackageRoot, binName);
        if (existsSync(binPath)) {
          throw new Error(`isolated_public_bin_not_clean:${binName}:${binPath}`);
        }
        return { binName, stagedPackageRoot, binPath };
      })
    );

    await Promise.all(
      stagedPackages.map(({ stagedPackageRoot }) =>
        runTypeScriptBuild(join(stagedPackageRoot, "tsconfig.json"))
      )
    );

    const binPaths = Object.fromEntries(
      stagedPackages.map(({ binName, binPath }) => {
        if (!existsSync(binPath)) {
          throw new Error(`isolated_public_bin_missing_after_build:${binName}:${binPath}`);
        }
        return [binName, binPath];
      })
    );
    return { root, binPaths };
  } catch (error) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "isolated_public_bin_setup_cleanup_failed");
    }
    throw error;
  }
}
