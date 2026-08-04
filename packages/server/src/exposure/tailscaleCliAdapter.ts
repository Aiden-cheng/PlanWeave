import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";
import { tailscaleExposureFailure } from "./errors.js";
import type {
  PrivateHttpsRequest,
  TailscaleControlPort,
  TailscaleNodeState,
  TailscaleServeLease,
  TailscaleServeState
} from "./types.js";

const execOptions = {
  encoding: "utf8" as const,
  timeout: 5_000,
  maxBuffer: 1024 * 1024,
  windowsHide: true
};

export type TailscaleExecFileResult = { stdout: string; stderr: string };
export type TailscaleExecFileRunner = (
  file: string,
  args: readonly string[],
  options: typeof execOptions
) => Promise<TailscaleExecFileResult>;

const versionSchema = z
  .object({
    majorMinorPatch: z.string()
  })
  .loose();

const nodeStatusSchema = z
  .object({
    BackendState: z.string(),
    Self: z
      .object({
        ID: z.string().min(1),
        DNSName: z.string().min(1)
      })
      .loose()
      .optional(),
    CurrentTailnet: z
      .object({
        MagicDNSEnabled: z.boolean(),
        MagicDNSSuffix: z.string().optional()
      })
      .loose()
      .optional(),
    CertDomains: z.array(z.string()).nullish()
  })
  .loose();

const serveConfigSchema = z.record(z.string(), z.unknown());

export const TAILSCALE_MINIMUM_STABLE_MINOR = 52;

function defaultExecFileRunner(
  file: string,
  args: readonly string[],
  options: typeof execOptions
): Promise<TailscaleExecFileResult> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw tailscaleExposureFailure("TAILSCALE_JSON_INVALID");
  }
}

function parseVersion(output: string): string {
  const parsed = versionSchema.safeParse(parseJson(output));
  if (!parsed.success) throw tailscaleExposureFailure("TAILSCALE_JSON_INVALID");
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(parsed.data.majorMinorPatch);
  if (!match) throw tailscaleExposureFailure("TAILSCALE_VERSION_UNSUPPORTED");
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (
    major !== 1 ||
    minor < TAILSCALE_MINIMUM_STABLE_MINOR ||
    minor % 2 !== 0
  ) {
    throw tailscaleExposureFailure("TAILSCALE_VERSION_UNSUPPORTED");
  }
  return parsed.data.majorMinorPatch;
}

function normalizeDnsName(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function parseNodeStatus(output: string, version: string): TailscaleNodeState {
  const parsed = nodeStatusSchema.safeParse(parseJson(output));
  if (!parsed.success) throw tailscaleExposureFailure("TAILSCALE_JSON_INVALID");
  const { BackendState: state } = parsed.data;
  if (state === "Stopped" || state === "NoState") {
    throw tailscaleExposureFailure("TAILSCALE_DAEMON_NOT_RUNNING");
  }
  if (state === "NeedsLogin") throw tailscaleExposureFailure("TAILSCALE_LOGIN_REQUIRED");
  if (state === "NeedsMachineAuth") {
    throw tailscaleExposureFailure("TAILSCALE_MACHINE_AUTH_REQUIRED");
  }
  if (state !== "Running" || !parsed.data.Self) {
    throw tailscaleExposureFailure("TAILSCALE_JSON_INVALID");
  }
  const dnsName = normalizeDnsName(parsed.data.Self.DNSName);
  const magicDnsSuffix = parsed.data.CurrentTailnet?.MagicDNSSuffix
    ? normalizeDnsName(parsed.data.CurrentTailnet.MagicDNSSuffix)
    : "";
  if (
    parsed.data.CurrentTailnet?.MagicDNSEnabled !== true ||
    !magicDnsSuffix ||
    !dnsName.endsWith(`.${magicDnsSuffix}`)
  ) {
    throw tailscaleExposureFailure("TAILSCALE_MAGIC_DNS_UNAVAILABLE");
  }
  const certDomains = (parsed.data.CertDomains ?? []).map(normalizeDnsName);
  if (!certDomains.includes(dnsName)) {
    throw tailscaleExposureFailure("TAILSCALE_HTTPS_UNAVAILABLE");
  }
  return {
    version,
    nodeIdentitySha256: sha256(parsed.data.Self.ID),
    dnsName
  };
}

function parseServeState(output: string): TailscaleServeState {
  const raw = parseJson(output);
  if (raw === null) return { config: null };
  const parsed = serveConfigSchema.safeParse(raw);
  if (!parsed.success) throw tailscaleExposureFailure("TAILSCALE_JSON_INVALID");
  return {
    config: { raw: parsed.data }
  };
}

function safeCommandCause(error: unknown): Error {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "UNKNOWN";
  return new Error(`tailscale_cli_failure:${code}`);
}

export class TailscaleCliAdapter implements TailscaleControlPort {
  constructor(
    private readonly run: TailscaleExecFileRunner = defaultExecFileRunner,
    private readonly executable = "tailscale"
  ) {}

  async inspectNode(): Promise<TailscaleNodeState> {
    let versionOutput: TailscaleExecFileResult;
    try {
      versionOutput = await this.run(this.executable, ["version", "--json"], execOptions);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        throw tailscaleExposureFailure("TAILSCALE_NOT_INSTALLED");
      }
      throw tailscaleExposureFailure("TAILSCALE_COMMAND_FAILED", safeCommandCause(error));
    }
    const version = parseVersion(versionOutput.stdout);
    try {
      const status = await this.run(
        this.executable,
        ["status", "--json", "--peers=false"],
        execOptions
      );
      return parseNodeStatus(status.stdout, version);
    } catch (error) {
      if (error instanceof Error && error.name === "TailscaleExposureError") throw error;
      throw tailscaleExposureFailure("TAILSCALE_COMMAND_FAILED", safeCommandCause(error));
    }
  }

  async inspectServe(): Promise<TailscaleServeState> {
    try {
      const result = await this.run(this.executable, ["serve", "status", "--json"], execOptions);
      return parseServeState(result.stdout);
    } catch (error) {
      if (error instanceof Error && error.name === "TailscaleExposureError") throw error;
      throw tailscaleExposureFailure("TAILSCALE_COMMAND_FAILED", safeCommandCause(error));
    }
  }

  async ensurePrivateHttps(input: PrivateHttpsRequest): Promise<TailscaleServeState> {
    try {
      await this.run(
        this.executable,
        ["serve", "--bg", "--https=443", input.backendOrigin],
        execOptions
      );
    } catch (error) {
      throw tailscaleExposureFailure("TAILSCALE_COMMAND_FAILED", safeCommandCause(error));
    }
    return this.inspectServe();
  }

  async releasePrivateHttps(_lease: TailscaleServeLease): Promise<void> {
    try {
      await this.run(this.executable, ["serve", "--https=443", "--set-path=/", "off"], execOptions);
    } catch (error) {
      throw tailscaleExposureFailure("TAILSCALE_COMMAND_FAILED", safeCommandCause(error));
    }
  }
}
