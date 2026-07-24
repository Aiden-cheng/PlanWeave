import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import {
  parseVpsE2eGate,
  precondition,
  redactSensitiveText,
  remoteVpsE2eConfigSchema,
  resolveVpsE2eTarget,
  runVpsE2eCli
} from "../vpsE2e/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("VPS e2e gate and redaction (unit)", () => {
  it("parses soft, require, disabled gates and profile defaults", () => {
    expect(parseVpsE2eGate({})).toEqual({
      enabled: false,
      mode: "disabled",
      profileId: "local-tls-fixture",
      configPath: null
    });
    expect(parseVpsE2eGate({ PLANWEAVE_VPS_E2E: "1" })).toMatchObject({
      enabled: true,
      mode: "soft",
      profileId: "local-tls-fixture"
    });
    expect(
      parseVpsE2eGate({
        PLANWEAVE_VPS_E2E_REQUIRE: "1",
        PLANWEAVE_VPS_E2E_PROFILE: "remote-vps",
        PLANWEAVE_VPS_E2E_CONFIG: "/tmp/outside-config.json"
      })
    ).toEqual({
      enabled: true,
      mode: "require",
      profileId: "remote-vps",
      configPath: "/tmp/outside-config.json"
    });
  });

  it("maps precondition disposition from gate mode", () => {
    expect(precondition("soft", "openssl_missing", "missing").disposition).toBe("skip");
    expect(precondition("require", "openssl_missing", "missing").disposition).toBe("fail");
  });

  it("redacts tokens, enrollment codes, PEM, home paths, and URLs", () => {
    const raw = [
      "Authorization: Bearer supersecrettokenvalue",
      "enrollmentCode=pw_enroll_abcDEF123",
      "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
      "path=/Users/alice/secret/config.json",
      "url=https://coordinator.example.com:7443/api"
    ].join("\n");
    const redacted = redactSensitiveText(raw);
    expect(redacted).not.toMatch(/supersecrettokenvalue/);
    expect(redacted).not.toMatch(/pw_enroll_/);
    expect(redacted).not.toMatch(/BEGIN CERTIFICATE/);
    expect(redacted).not.toMatch(/\/Users\/alice/);
    expect(redacted).not.toMatch(/coordinator\.example\.com/);
    expect(redacted).toMatch(/REDACTED/);
  });

  it("validates remote config schema without embedding secrets", () => {
    const parsed = remoteVpsE2eConfigSchema.parse({
      version: "planweave.vps-e2e-config/v1",
      environmentClass: "remote-vps",
      coordinatorUrl: "https://127.0.0.1:7443",
      operatorTokenEnv: "PLANWEAVE_VPS_OPERATOR_TOKEN",
      hostConfigPath: "/etc/planweave/agent-host.json",
      projectId: "project-example"
    });
    expect(parsed.blockRef).toBe("T-001#B-001");
    expect(parsed.operatorTokenEnv).toBe("PLANWEAVE_VPS_OPERATOR_TOKEN");
    expect(() =>
      remoteVpsE2eConfigSchema.parse({
        version: "planweave.vps-e2e-config/v1",
        environmentClass: "remote-vps",
        coordinatorUrl: "http://127.0.0.1:7443",
        hostConfigPath: "/etc/planweave/agent-host.json",
        projectId: "project-example"
      })
    ).toThrow();
  });

  it("resolves local-tls-fixture without external config", async () => {
    const gate = parseVpsE2eGate({ PLANWEAVE_VPS_E2E: "1" });
    await expect(resolveVpsE2eTarget(gate, {})).resolves.toEqual({ kind: "local-tls-fixture" });
  });

  it("soft-skips remote-vps when config path is missing", async () => {
    const gate = parseVpsE2eGate({
      PLANWEAVE_VPS_E2E: "1",
      PLANWEAVE_VPS_E2E_PROFILE: "remote-vps"
    });
    const target = await resolveVpsE2eTarget(gate, {});
    expect(target.kind).toBe("precondition");
    if (target.kind !== "precondition") return;
    expect(target.precondition.kind).toBe("remote_config_missing");
    expect(target.precondition.disposition).toBe("skip");
  });

  it("loads remote config from absolute path and token env only", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-vps-e2e-config-"));
    roots.push(root);
    const configPath = join(root, "remote.json");
    await writeFile(
      configPath,
      JSON.stringify({
        version: "planweave.vps-e2e-config/v1",
        environmentClass: "remote-vps",
        coordinatorUrl: "https://127.0.0.1:7443",
        operatorTokenEnv: "PLANWEAVE_VPS_OPERATOR_TOKEN",
        hostConfigPath: "/var/lib/planweave/agent-host.json",
        projectId: "project-example"
      }),
      "utf8"
    );
    const gate = parseVpsE2eGate({
      PLANWEAVE_VPS_E2E: "1",
      PLANWEAVE_VPS_E2E_PROFILE: "remote-vps",
      PLANWEAVE_VPS_E2E_CONFIG: configPath
    });
    const missingToken = await resolveVpsE2eTarget(gate, {});
    expect(missingToken.kind).toBe("precondition");
    if (missingToken.kind === "precondition") {
      expect(missingToken.precondition.kind).toBe("remote_token_missing");
    }
    const resolved = await resolveVpsE2eTarget(gate, {
      PLANWEAVE_VPS_OPERATOR_TOKEN: "token-value-not-stored-in-repo"
    });
    expect(resolved.kind).toBe("remote-vps");
    if (resolved.kind !== "remote-vps") return;
    expect(resolved.config.projectId).toBe("project-example");
    expect(resolved.operatorToken).toBe("token-value-not-stored-in-repo");
  });

  it("CLI usage rejects unknown flags", async () => {
    const code = await runVpsE2eCli(["--unknown"], {
      io: { stdout() {}, stderr() {} },
      env: { PLANWEAVE_VPS_E2E: "1" }
    });
    expect(code).toBe(2);
  });
});
