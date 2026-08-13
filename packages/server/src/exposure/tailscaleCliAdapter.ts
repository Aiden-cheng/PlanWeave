import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { win32 as windowsPath } from "node:path";
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
export type TailscaleExecFileOptions = typeof execOptions & { forceCliMode?: boolean };
export type TailscaleExecFileRunner = (
  file: string,
  args: readonly string[],
  options: TailscaleExecFileOptions
) => Promise<TailscaleExecFileResult>;

export type TailscaleCliAdapterOptions = {
  executable?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
};

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
  options: TailscaleExecFileOptions
): Promise<TailscaleExecFileResult> {
  const { forceCliMode, ...childOptions } = options;
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      forceCliMode
        ? {
            ...childOptions,
            env: { ...process.env, TAILSCALE_BE_CLI: "1" }
          }
        : childOptions,
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function windowsProgramFiles(env: NodeJS.ProcessEnv): string | null {
  return env.ProgramW6432 ?? env.ProgramFiles ?? env.PROGRAMFILES ?? null;
}

function executableCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): readonly string[] {
  if (platform === "darwin") {
    return [
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      "/usr/local/bin/tailscale",
      "tailscale"
    ];
  }
  if (platform === "win32") {
    const programFiles = windowsProgramFiles(env);
    return unique([
      "tailscale.exe",
      programFiles ? windowsPath.join(programFiles, "Tailscale", "tailscale.exe") : ""
    ]);
  }
  if (platform === "linux") {
    return ["tailscale", "/usr/bin/tailscale", "/usr/local/bin/tailscale"];
  }
  return ["tailscale"];
}

function isMissingExecutable(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
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
  if (major !== 1 || minor < TAILSCALE_MINIMUM_STABLE_MINOR || minor % 2 !== 0) {
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
  private readonly candidates: readonly string[];
  private readonly commandOptions: TailscaleExecFileOptions;
  private resolvedExecutable: string | null = null;

  constructor(
    private readonly run: TailscaleExecFileRunner = defaultExecFileRunner,
    options: string | TailscaleCliAdapterOptions = {}
  ) {
    const normalized = typeof options === "string" ? { executable: options } : options;
    const platform = normalized.platform ?? process.platform;
    this.candidates = normalized.executable
      ? [normalized.executable]
      : executableCandidates(platform, normalized.env ?? process.env);
    this.commandOptions = { ...execOptions, forceCliMode: platform === "darwin" };
  }

  private async execute(args: readonly string[]): Promise<TailscaleExecFileResult> {
    const candidates = this.resolvedExecutable
      ? unique([this.resolvedExecutable, ...this.candidates])
      : this.candidates;
    for (const executable of candidates) {
      try {
        const result = await this.run(executable, args, this.commandOptions);
        this.resolvedExecutable = executable;
        return result;
      } catch (error) {
        if (isMissingExecutable(error)) {
          if (this.resolvedExecutable === executable) this.resolvedExecutable = null;
          continue;
        }
        throw tailscaleExposureFailure("TAILSCALE_COMMAND_FAILED", safeCommandCause(error));
      }
    }
    throw tailscaleExposureFailure("TAILSCALE_NOT_INSTALLED");
  }

  async inspectNode(): Promise<TailscaleNodeState> {
    const versionOutput = await this.execute(["version", "--json"]);
    const version = parseVersion(versionOutput.stdout);
    const status = await this.execute(["status", "--json", "--peers=false"]);
    return parseNodeStatus(status.stdout, version);
  }

  async inspectServe(): Promise<TailscaleServeState> {
    const result = await this.execute(["serve", "status", "--json"]);
    return parseServeState(result.stdout);
  }

  async ensurePrivateHttps(input: PrivateHttpsRequest): Promise<TailscaleServeState> {
    await this.execute(["serve", "--bg", "--https=443", input.backendOrigin]);
    return this.inspectServe();
  }

  async releasePrivateHttps(_lease: TailscaleServeLease): Promise<void> {
    await this.execute(["serve", "--https=443", "--set-path=/", "off"]);
  }
}
