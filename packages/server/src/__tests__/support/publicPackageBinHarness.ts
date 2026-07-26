import { spawn } from "node:child_process";
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
