import { z } from "zod";
import type { ServerConfig } from "../config.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const tailscaleServeLeaseSchema = z
  .object({
    leaseId: sha256Schema,
    configFingerprint: sha256Schema,
    nodeIdentitySha256: sha256Schema,
    advertisedOrigin: z.url(),
    httpsPort: z.literal(443),
    path: z.literal("/"),
    backendOrigin: z.url(),
    serveConfigSha256: sha256Schema,
    createdAt: z.iso.datetime()
  })
  .strict();

export type TailscaleServeLease = z.infer<typeof tailscaleServeLeaseSchema>;

export type TailscaleNodeState = {
  version: string;
  nodeIdentitySha256: string;
  dnsName: string;
};

export type TailscaleServeConfig = {
  raw: Readonly<Record<string, unknown>>;
};

export type TailscaleServeState = { config: TailscaleServeConfig | null };

export type PrivateHttpsRequest = {
  advertisedOrigin: string;
  backendOrigin: string;
};

export interface TailscaleControlPort {
  inspectNode(): Promise<TailscaleNodeState>;
  inspectServe(): Promise<TailscaleServeState>;
  ensurePrivateHttps(input: PrivateHttpsRequest): Promise<TailscaleServeState>;
  releasePrivateHttps(lease: TailscaleServeLease): Promise<void>;
}

export interface ExposureLeaseStorePort {
  load(): TailscaleServeLease | null;
  insertIfAbsent(lease: TailscaleServeLease): boolean;
  replaceExact(expected: TailscaleServeLease, replacement: TailscaleServeLease): boolean;
  deleteExact(lease: TailscaleServeLease): boolean;
}

export type ExposureOwnership = {
  kind: "tailscale_serve";
  lease: TailscaleServeLease;
  createdByActivation: boolean;
};

export type PreparedServerExposure = {
  listener: ServerConfig["transport"]["listener"];
  advertisedOrigin: string;
  ownership?: ExposureOwnership;
};

export type ExposureInspection = {
  state: "not_applicable" | "available" | "ready";
  listener: ServerConfig["transport"]["listener"];
  advertisedOrigin: string;
};

export interface ServerExposureLifecyclePort {
  inspect(config: ServerConfig): Promise<ExposureInspection>;
  activate(config: ServerConfig): Promise<PreparedServerExposure>;
  release(ownership: ExposureOwnership): Promise<void>;
}
