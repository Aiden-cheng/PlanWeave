import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactPathForEvidence } from "./redaction.js";

export type LocalTlsMaterial = {
  directory: string;
  certificatePath: string;
  privateKeyPath: string;
  caCertificatePath: string;
  /** Sanitized openssl command line for evidence (no paths leaked as-is). */
  commandsSanitized: string[];
};

export function resolveOpensslBinary(
  env: Readonly<Record<string, string | undefined>> = process.env
): string | null {
  const candidates = [
    env.PLANWEAVE_VPS_E2E_OPENSSL,
    "openssl",
    "/opt/homebrew/bin/openssl",
    "/usr/bin/openssl"
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

/**
 * Generate a disposable self-signed certificate for loopback HTTPS/WSS.
 * Used only by environmentClass=local-tls-fixture (not a production CA claim).
 */
export async function generateLocalTlsMaterial(
  rootDirectory: string,
  options: { opensslBinary?: string | null; commonName?: string } = {}
): Promise<LocalTlsMaterial> {
  const openssl = options.opensslBinary ?? resolveOpensslBinary();
  if (!openssl) throw new Error("vps_e2e_openssl_missing");

  const directory = join(rootDirectory, "tls");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const privateKeyPath = join(directory, "server.key");
  const certificatePath = join(directory, "server.crt");
  const caCertificatePath = certificatePath; // self-signed: cert is the trust anchor
  const commonName = options.commonName ?? "127.0.0.1";

  const args = [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    privateKeyPath,
    "-out",
    certificatePath,
    "-days",
    "1",
    "-subj",
    `/CN=${commonName}`,
    "-addext",
    "subjectAltName=IP:127.0.0.1,IP:::1,DNS:localhost"
  ];
  const result = spawnSync(openssl, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `vps_e2e_tls_material_failed:${(result.stderr || result.stdout || "").slice(0, 200)}`
    );
  }

  // Restrict key material immediately.
  await writeFile(join(directory, "README.redacted.txt"), "ephemeral local-tls-fixture material\n", {
    mode: 0o600
  });

  return {
    directory,
    certificatePath,
    privateKeyPath,
    caCertificatePath,
    commandsSanitized: [
      `openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=${commonName} -addext subjectAltName=IP:127.0.0.1 (paths redacted: ${redactPathForEvidence(directory)})`
    ]
  };
}
