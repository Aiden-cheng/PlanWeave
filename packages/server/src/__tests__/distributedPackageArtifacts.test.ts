import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentHostProtocolVersion } from "@planweave-ai/distributed-protocol";
import { serverPackageVersion } from "../packageInfo.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

function readPackageJson(relativePath: string): {
  name: string;
  version: string;
  engines?: { node?: string };
  bin?: Record<string, string>;
  files?: string[];
  publishConfig?: { access?: string };
  license?: string;
  dependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8")) as {
    name: string;
    version: string;
    engines?: { node?: string };
    bin?: Record<string, string>;
    files?: string[];
    publishConfig?: { access?: string };
    license?: string;
    dependencies?: Record<string, string>;
  };
}

describe("distributed package artifact contracts", () => {
  it("pins engines, bins, licenses, and publish metadata for shippable packages", () => {
    const protocol = readPackageJson("packages/distributed-protocol/package.json");
    const contracts = readPackageJson("packages/collaboration-contracts/package.json");
    const runtime = readPackageJson("packages/runtime/package.json");
    const server = readPackageJson("packages/server/package.json");
    const host = readPackageJson("packages/agent-host/package.json");

    for (const pkg of [protocol, contracts, runtime, server, host]) {
      expect(pkg.engines?.node).toBe(">=22.5");
      expect(pkg.license).toBe("MIT");
      expect(pkg.files).toEqual(["dist"]);
      expect(pkg.publishConfig?.access).toBe("public");
      expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    }

    expect(server.name).toBe("@planweave-ai/server");
    expect(host.name).toBe("@planweave-ai/agent-host");
    expect(server.bin?.["planweave-server"]).toBe("./dist/bin.js");
    expect(host.bin?.["planweave-agent-host"]).toBe("./dist/bin.js");
    expect(server.version).toBe(serverPackageVersion);
    expect(host.version).toBe(serverPackageVersion);
    expect(protocol.version).toBe(serverPackageVersion);
    expect(server.dependencies?.["@planweave-ai/distributed-protocol"]).toBe("workspace:*");
    expect(host.dependencies?.["@planweave-ai/distributed-protocol"]).toBe("workspace:*");
    expect(agentHostProtocolVersion).toBe(1);
  });

  it("keeps Server/Host free of native better-sqlite3 package dependencies", () => {
    const server = readPackageJson("packages/server/package.json");
    const host = readPackageJson("packages/agent-host/package.json");
    const forbidden = ["better-sqlite3", "sqlite3", "node-gyp-build"];
    for (const name of forbidden) {
      expect(server.dependencies?.[name]).toBeUndefined();
      expect(host.dependencies?.[name]).toBeUndefined();
    }
  });
});
