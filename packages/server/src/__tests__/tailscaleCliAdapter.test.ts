import { describe, expect, it } from "vitest";
import { TailscaleExposureError } from "../exposure/errors.js";
import {
  TailscaleCliAdapter,
  type TailscaleExecFileRunner
} from "../exposure/tailscaleCliAdapter.js";

const healthyStatus = {
  BackendState: "Running",
  Self: {
    ID: "node-stable-id",
    DNSName: "planweave.example.ts.net."
  },
  CurrentTailnet: {
    MagicDNSEnabled: true,
    MagicDNSSuffix: "example.ts.net"
  },
  CertDomains: ["planweave.example.ts.net"]
};

const serveConfig = {
  TCP: { "443": { HTTPS: true } },
  Web: {
    "planweave.example.ts.net:443": {
      Handlers: { "/": { Proxy: "http://127.0.0.1:7443" } }
    }
  },
  AllowFunnel: { "planweave.example.ts.net:443": false }
};

type Call = { file: string; args: readonly string[]; options: unknown };

const missingExecutable = () =>
  Object.assign(new Error("missing tailscale executable"), {
    code: "ENOENT"
  });

function queuedRunner(outputs: Array<{ stdout?: unknown; error?: unknown }>): {
  run: TailscaleExecFileRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const run: TailscaleExecFileRunner = async (file, args, options) => {
    calls.push({ file, args, options });
    const next = outputs.shift();
    if (!next) throw new Error("unexpected_tailscale_call");
    if (next.error) throw next.error;
    return {
      stdout: typeof next.stdout === "string" ? next.stdout : JSON.stringify(next.stdout),
      stderr: ""
    };
  };
  return { run, calls };
}

function testAdapter(run: TailscaleExecFileRunner): TailscaleCliAdapter {
  return new TailscaleCliAdapter(run, { executable: "tailscale", platform: "linux", env: {} });
}

function errorCode(error: unknown): string | undefined {
  return error instanceof TailscaleExposureError ? error.code : undefined;
}

describe("TailscaleCliAdapter", () => {
  it("finds the bundled macOS CLI outside PATH and forces CLI mode", async () => {
    const fake = queuedRunner([
      { stdout: { majorMinorPatch: "1.102.1" } },
      { stdout: healthyStatus }
    ]);
    const adapter = new TailscaleCliAdapter(fake.run, {
      platform: "darwin",
      env: {}
    });

    await expect(adapter.inspectNode()).resolves.toMatchObject({ version: "1.102.1" });
    expect(fake.calls).toEqual([
      expect.objectContaining({
        file: "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        args: ["version", "--json"],
        options: expect.objectContaining({ forceCliMode: true })
      }),
      expect.objectContaining({
        file: "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        args: ["status", "--json", "--peers=false"],
        options: expect.objectContaining({ forceCliMode: true })
      })
    ]);
  });

  it("falls back to the installed macOS CLI integration when the app bundle is absent", async () => {
    const fake = queuedRunner([
      { error: missingExecutable() },
      { stdout: { majorMinorPatch: "1.102.1" } },
      { stdout: healthyStatus }
    ]);
    const adapter = new TailscaleCliAdapter(fake.run, {
      platform: "darwin",
      env: {}
    });

    await expect(adapter.inspectNode()).resolves.toMatchObject({ version: "1.102.1" });
    expect(fake.calls.map((call) => call.file)).toEqual([
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      "/usr/local/bin/tailscale",
      "/usr/local/bin/tailscale"
    ]);
  });

  it("finds Windows Tailscale after a GUI process inherits a stale PATH", async () => {
    const fake = queuedRunner([
      { error: missingExecutable() },
      { stdout: { majorMinorPatch: "1.102.1" } },
      { stdout: healthyStatus }
    ]);
    const adapter = new TailscaleCliAdapter(fake.run, {
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files" }
    });

    await expect(adapter.inspectNode()).resolves.toMatchObject({ version: "1.102.1" });
    expect(fake.calls.map((call) => call.file)).toEqual([
      "tailscale.exe",
      "C:\\Program Files\\Tailscale\\tailscale.exe",
      "C:\\Program Files\\Tailscale\\tailscale.exe"
    ]);
    expect(fake.calls[0]?.options).toEqual(expect.objectContaining({ forceCliMode: false }));
  });

  it("falls back to the standard Linux package path", async () => {
    const fake = queuedRunner([
      { error: missingExecutable() },
      { stdout: { majorMinorPatch: "1.102.1" } },
      { stdout: healthyStatus }
    ]);
    const adapter = new TailscaleCliAdapter(fake.run, {
      platform: "linux",
      env: {}
    });

    await expect(adapter.inspectNode()).resolves.toMatchObject({ version: "1.102.1" });
    expect(fake.calls.map((call) => call.file)).toEqual([
      "tailscale",
      "/usr/bin/tailscale",
      "/usr/bin/tailscale"
    ]);
  });

  it("does not hide an installed candidate failure behind another executable", async () => {
    const fake = queuedRunner([
      {
        error: Object.assign(new Error("Tailscale command failed"), { code: "EPERM" })
      },
      { stdout: { majorMinorPatch: "1.102.1" } }
    ]);
    const adapter = new TailscaleCliAdapter(fake.run, {
      platform: "darwin",
      env: {}
    });

    await expect(adapter.inspectNode()).rejects.toMatchObject({ code: "TAILSCALE_COMMAND_FAILED" });
    expect(fake.calls.map((call) => call.file)).toEqual([
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
    ]);
  });

  it("uses fixed structured argv and returns a redacted node identity", async () => {
    const fake = queuedRunner([
      { stdout: { majorMinorPatch: "1.52.0", Extra: "accepted" } },
      { stdout: { ...healthyStatus, Services: { metadata: true } } }
    ]);
    const adapter = testAdapter(fake.run);

    await expect(adapter.inspectNode()).resolves.toEqual({
      version: "1.52.0",
      nodeIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      dnsName: "planweave.example.ts.net"
    });
    expect(fake.calls).toEqual([
      {
        file: "tailscale",
        args: ["version", "--json"],
        options: {
          encoding: "utf8",
          timeout: 5_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          forceCliMode: false
        }
      },
      {
        file: "tailscale",
        args: ["status", "--json", "--peers=false"],
        options: {
          encoding: "utf8",
          timeout: 5_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          forceCliMode: false
        }
      }
    ]);
  });

  it.each([
    [{ BackendState: "Stopped" }, "TAILSCALE_DAEMON_NOT_RUNNING"],
    [{ BackendState: "NoState" }, "TAILSCALE_DAEMON_NOT_RUNNING"],
    [{ BackendState: "NeedsLogin" }, "TAILSCALE_LOGIN_REQUIRED"],
    [{ BackendState: "NeedsMachineAuth" }, "TAILSCALE_MACHINE_AUTH_REQUIRED"]
  ])("fails closed for node state %#", async (status, code) => {
    const fake = queuedRunner([{ stdout: { majorMinorPatch: "1.80.1" } }, { stdout: status }]);
    await expect(testAdapter(fake.run).inspectNode()).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === code
    );
  });

  it("distinguishes disabled MagicDNS and HTTPS certificate consent", async () => {
    const noMagicDns = queuedRunner([
      { stdout: { majorMinorPatch: "1.80.1" } },
      {
        stdout: {
          ...healthyStatus,
          CurrentTailnet: {
            MagicDNSEnabled: false,
            MagicDNSSuffix: "example.ts.net"
          }
        }
      }
    ]);
    await expect(testAdapter(noMagicDns.run).inspectNode()).rejects.toMatchObject({
      code: "TAILSCALE_MAGIC_DNS_UNAVAILABLE"
    });

    const noCertificate = queuedRunner([
      { stdout: { majorMinorPatch: "1.80.1" } },
      { stdout: { ...healthyStatus, CertDomains: [] } }
    ]);
    await expect(testAdapter(noCertificate.run).inspectNode()).rejects.toMatchObject({
      code: "TAILSCALE_HTTPS_UNAVAILABLE"
    });

    const nullCertificateDomains = queuedRunner([
      { stdout: { majorMinorPatch: "1.102.1" } },
      { stdout: { ...healthyStatus, CertDomains: null } }
    ]);
    await expect(testAdapter(nullCertificateDomains.run).inspectNode()).rejects.toMatchObject({
      code: "TAILSCALE_HTTPS_UNAVAILABLE"
    });
  });

  it.each([
    "1.52.0",
    "1.52.999",
    "1.80.1",
    "1.98.9",
    "1.100.0",
    "1.102.1"
  ])("accepts explicitly verified stable version %s", async (version) => {
    const fake = queuedRunner([
      { stdout: { majorMinorPatch: version } },
      { stdout: healthyStatus }
    ]);
    await expect(testAdapter(fake.run).inspectNode()).resolves.toMatchObject({
      version
    });
  });

  it.each([
    "1.51.9",
    "1.53.0",
    "1.99.0",
    "2.0.0",
    "1.98.9-rc1",
    "dev"
  ])("rejects unsupported version %s", async (version) => {
    const fake = queuedRunner([{ stdout: { majorMinorPatch: version } }]);
    await expect(testAdapter(fake.run).inspectNode()).rejects.toMatchObject({
      code: "TAILSCALE_VERSION_UNSUPPORTED"
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("rejects the non-contract uppercase version key", async () => {
    const fake = queuedRunner([{ stdout: { MajorMinorPatch: "1.98.9" } }]);
    await expect(testAdapter(fake.run).inspectNode()).rejects.toMatchObject({
      code: "TAILSCALE_JSON_INVALID"
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("maps ENOENT separately and never leaks command diagnostics", async () => {
    const missing = queuedRunner([
      {
        error: Object.assign(new Error("/Users/alice/tailscale missing token=secret"), {
          code: "ENOENT"
        })
      }
    ]);
    await expect(testAdapter(missing.run).inspectNode()).rejects.toMatchObject({
      code: "TAILSCALE_NOT_INSTALLED",
      message: "Tailscale CLI is not installed."
    });

    const failed = queuedRunner([
      {
        error: Object.assign(
          new Error("Bearer secret-token AuthURL=https://login.example /Users/alice/private"),
          { code: "EPERM" }
        )
      }
    ]);
    const error = await testAdapter(failed.run)
      .inspectNode()
      .catch((caught) => caught);
    expect(error).toMatchObject({ code: "TAILSCALE_COMMAND_FAILED" });
    expect(String(error)).not.toMatch(/secret-token|login\.example|Users\/alice/);
    expect(String(error.cause)).toBe("Error: tailscale_cli_failure:EPERM");
  });

  it("rejects malformed or structurally incomplete JSON without text fallback", async () => {
    const malformed = queuedRunner([{ stdout: "not-json: NeedsLogin" }]);
    await expect(testAdapter(malformed.run).inspectNode()).rejects.toMatchObject({
      code: "TAILSCALE_JSON_INVALID"
    });

    const incomplete = queuedRunner([{ stdout: { Long: "1.80.1" } }]);
    await expect(testAdapter(incomplete.run).inspectNode()).rejects.toMatchObject({
      code: "TAILSCALE_JSON_INVALID"
    });
  });

  it("accepts null Serve status and structured configs with unknown fields", async () => {
    const none = queuedRunner([{ stdout: null }]);
    await expect(testAdapter(none.run).inspectServe()).resolves.toEqual({
      config: null
    });

    const opaque = {
      TCP: {
        "443": {
          HTTPS: true,
          HTTP: true,
          TerminateTLS: "localhost:443",
          ProxyProtocol: 1,
          UnknownTCP: { future: true }
        }
      },
      Web: {
        "planweave.example.ts.net:443": {
          Handlers: {
            "/": {
              Proxy: "http://127.0.0.1:7443",
              AcceptAppCaps: true,
              Redirect: "https://other.example",
              UnknownHandler: [1, 2]
            }
          },
          UnknownWeb: "preserved"
        }
      },
      AllowFunnel: { "planweave.example.ts.net:443": false },
      Foreground: { "session-1": { TCP: { "8443": { TCPForward: "127.0.0.1:8443" } } } },
      Services: { "svc:other": { Tun: true, UnknownService: 9 } },
      UnknownMetadata: { revision: 4 }
    };
    const configured = queuedRunner([{ stdout: opaque }]);
    await expect(testAdapter(configured.run).inspectServe()).resolves.toEqual({
      config: { raw: opaque }
    });
  });

  it("uses only the fixed create and exact release commands", async () => {
    const fake = queuedRunner([{ stdout: "" }, { stdout: serveConfig }, { stdout: "" }]);
    const adapter = testAdapter(fake.run);
    await adapter.ensurePrivateHttps({
      advertisedOrigin: "https://planweave.example.ts.net",
      backendOrigin: "http://127.0.0.1:7443"
    });
    await adapter.releasePrivateHttps({
      leaseId: "a".repeat(64),
      configFingerprint: "b".repeat(64),
      nodeIdentitySha256: "c".repeat(64),
      advertisedOrigin: "https://planweave.example.ts.net",
      httpsPort: 443,
      path: "/",
      backendOrigin: "http://127.0.0.1:7443",
      serveConfigSha256: "d".repeat(64),
      createdAt: "2026-08-03T00:00:00.000Z"
    });

    expect(fake.calls.map((call) => call.args)).toEqual([
      ["serve", "--bg", "--https=443", "http://127.0.0.1:7443"],
      ["serve", "status", "--json"],
      ["serve", "--https=443", "--set-path=/", "off"]
    ]);
    expect(fake.calls.flatMap((call) => call.args)).not.toEqual(
      expect.arrayContaining(["funnel", "reset", "set-config", "set-raw"])
    );
  });
});
