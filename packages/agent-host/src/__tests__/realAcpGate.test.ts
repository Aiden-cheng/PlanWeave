import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseRealAcpGate, precondition } from "../realAcp/gate.js";
import { resolveRealAcpHostProfile } from "../realAcp/resolveProfile.js";
import { listSupportedHostAcpProfiles } from "../realAcp/supportedProfiles.js";
import { runRealAcpSmokeCli } from "../realAcp/cli.js";

const tempRoots: string[] = [];

afterEach(async () => {
  // Temp roots are left for OS cleanup; tests only create tiny files.
  tempRoots.length = 0;
});

describe("real ACP gate and profile resolution", () => {
  it("parses soft, require, and disabled gates without reading secrets", () => {
    expect(parseRealAcpGate({})).toEqual({
      enabled: false,
      mode: "disabled",
      preferredProfileId: null
    });
    expect(parseRealAcpGate({ PLANWEAVE_REAL_ACP: "1" })).toMatchObject({
      enabled: true,
      mode: "soft"
    });
    expect(
      parseRealAcpGate({
        PLANWEAVE_REAL_ACP_REQUIRE: "1",
        PLANWEAVE_REAL_ACP_PROFILE: "codex-acp"
      })
    ).toEqual({
      enabled: true,
      mode: "require",
      preferredProfileId: "codex-acp"
    });
  });

  it("lists supported Host-local ACP profiles from the runtime registry", () => {
    const profiles = listSupportedHostAcpProfiles();
    expect(profiles.map((profile) => profile.profileId).sort()).toEqual([
      "claude-code-acp",
      "codex-acp",
      "grok-acp",
      "opencode-acp",
      "pi-acp"
    ]);
    for (const profile of profiles) {
      expect(profile.command.length).toBeGreaterThan(0);
      expect(profile.verifiedAdapterVersion.length).toBeGreaterThan(0);
    }
  });

  it("soft-skips when no binary is available and never falls back to CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-real-acp-empty-path-"));
    tempRoots.push(root);
    const outcome = await resolveRealAcpHostProfile({
      gate: { enabled: true, mode: "soft", preferredProfileId: null },
      env: {},
      pathEnv: root
    });
    expect(outcome.status).toBe("precondition");
    if (outcome.status !== "precondition") return;
    expect(outcome.precondition).toMatchObject({
      kind: "binary_missing",
      disposition: "skip"
    });
    expect(outcome.precondition.message).toMatch(/No CLI fallback|not found|Tried/i);
  });

  it("hard-fails missing preferred profile binary under require gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-real-acp-require-"));
    tempRoots.push(root);
    const outcome = await resolveRealAcpHostProfile({
      gate: { enabled: true, mode: "require", preferredProfileId: "codex-acp" },
      env: {},
      pathEnv: root
    });
    expect(outcome.status).toBe("precondition");
    if (outcome.status !== "precondition") return;
    expect(outcome.precondition).toMatchObject({
      kind: "binary_missing",
      disposition: "fail",
      profileId: "codex-acp"
    });
  });

  it("resolves an absolute Host-local profile when the command is executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-real-acp-bin-"));
    tempRoots.push(root);
    const command = join(root, "codex-acp");
    await writeFile(command, "#!/bin/sh\necho fixture\n", "utf8");
    await chmod(command, 0o755);

    const outcome = await resolveRealAcpHostProfile({
      gate: { enabled: true, mode: "soft", preferredProfileId: "codex-acp" },
      env: { PATH: root },
      pathEnv: root
    });
    expect(outcome.status).toBe("resolved");
    if (outcome.status !== "resolved") return;
    // macOS may resolve temp paths through /private; compare leaf identity, not raw string.
    expect(outcome.profile.commandPath.endsWith("/codex-acp")).toBe(true);
    expect(outcome.profile.hostProfile.agentId).toBe("codex");
    expect(outcome.profile.hostProfile.launch.command.endsWith("/codex-acp")).toBe(true);
  });

  it("records skip disposition in precondition helpers", () => {
    expect(precondition("soft", "auth_required", "login needed", "grok-acp")).toEqual({
      kind: "auth_required",
      disposition: "skip",
      message: "login needed",
      profileId: "grok-acp"
    });
    expect(precondition("require", "auth_required", "login needed", "grok-acp").disposition).toBe(
      "fail"
    );
  });

  it("lists profiles and soft-skips smoke when PATH has no agents", async () => {
    const lines: string[] = [];
    const listCode = await runRealAcpSmokeCli(["--list-profiles"], {
      io: { stdout: (value) => lines.push(value), stderr: () => undefined },
      env: {}
    });
    expect(listCode).toBe(0);
    const listed = JSON.parse(lines[0] ?? "{}") as { profiles: Array<{ profileId: string }> };
    expect(listed.profiles.some((profile) => profile.profileId === "codex-acp")).toBe(true);

    const empty = await mkdtemp(join(tmpdir(), "planweave-real-acp-cli-empty-"));
    tempRoots.push(empty);
    const smokeLines: string[] = [];
    const smokeCode = await runRealAcpSmokeCli([], {
      io: { stdout: (value) => smokeLines.push(value), stderr: () => undefined },
      env: { PATH: empty, PLANWEAVE_REAL_ACP: "1" }
    });
    expect(smokeCode).toBe(0);
    const evidence = JSON.parse(smokeLines[0] ?? "{}") as {
      result: string;
      disposition?: string;
      diagnostic: string | null;
    };
    expect(evidence.result).toBe("skipped");
    expect(evidence.disposition).toBe("skip");
    expect(evidence.diagnostic).toMatch(/binary_missing|No supported real ACP/);
  });

  it("returns exit 1 under --require when binary is missing", async () => {
    const empty = await mkdtemp(join(tmpdir(), "planweave-real-acp-cli-require-"));
    tempRoots.push(empty);
    const smokeLines: string[] = [];
    const smokeCode = await runRealAcpSmokeCli(["--require", "--profile", "pi-acp"], {
      io: { stdout: (value) => smokeLines.push(value), stderr: () => undefined },
      env: { PATH: empty }
    });
    expect(smokeCode).toBe(1);
    const evidence = JSON.parse(smokeLines[0] ?? "{}") as {
      result: string;
      disposition?: string;
    };
    expect(evidence.result).toBe("failed");
    expect(evidence.disposition).toBe("fail");
  });
});
