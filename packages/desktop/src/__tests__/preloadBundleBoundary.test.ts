import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

describe("sandboxed preload bundle", () => {
  it("does not require Node builtins", async () => {
    const result = await build({
      bundle: true,
      entryPoints: [resolve(desktopRoot, "src/preload/preload.ts")],
      external: [...nodeBuiltins, "electron", "electron-liquid-glass", "node-gyp-build"],
      format: "cjs",
      logLevel: "silent",
      outfile: resolve(desktopRoot, "dist/preload/preload.js"),
      platform: "node",
      target: "node20",
      write: false
    });
    const preloadBundle = result.outputFiles.find((file) => file.path.endsWith("preload.js"));
    const requiredSpecifiers = [
      ...(preloadBundle?.text.matchAll(/require\(["']([^"']+)["']\)/g) ?? [])
    ].map((match) => match[1]);

    expect(preloadBundle).toBeDefined();
    expect(requiredSpecifiers.filter((specifier) => nodeBuiltins.has(specifier))).toEqual([]);
  });
});
