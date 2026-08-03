import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const desktopRoot = resolve(import.meta.dirname, "../..");

describe("desktop development command", () => {
  it("reserves dev for the complete Electron lifecycle and exposes renderer-only mode explicitly", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(desktopRoot, "package.json"), "utf8")
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts.dev).toBe("node scripts/dev-desktop.mjs");
    expect(packageJson.scripts["dev:renderer"]).toBe("vite --host 127.0.0.1");
  });
});
