import { readFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import { createSecureContext, rootCertificates } from "node:tls";
import { Agent } from "undici";

const MAX_CA_CERTIFICATE_BYTES = 256 * 1024;

export type AgentHostTlsTrust = {
  ca?: string[];
  request: typeof fetch;
  close(): Promise<void>;
};

export async function createAgentHostTlsTrust(
  caCertificatePath?: string,
  environment: { readonly NODE_TLS_REJECT_UNAUTHORIZED?: string } = process.env
): Promise<AgentHostTlsTrust> {
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("agent_host_tls_verification_disabled");
  }
  if (!caCertificatePath) {
    return { request: fetch, async close() {} };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(caCertificatePath);
  } catch (error) {
    throw new Error("agent_host_ca_certificate_unreadable", { cause: error });
  }
  if (bytes.byteLength > MAX_CA_CERTIFICATE_BYTES) {
    throw new Error("agent_host_ca_certificate_too_large");
  }
  const customCertificate = bytes.toString("utf8");
  const ca = [...rootCertificates, customCertificate];
  try {
    const certificates = customCertificate.match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g
    );
    let remaining = customCertificate;
    for (const certificate of certificates ?? []) remaining = remaining.replace(certificate, "");
    if (!certificates || remaining.trim()) {
      throw new Error("invalid_ca_pem");
    }
    for (const certificate of certificates) new X509Certificate(certificate);
    createSecureContext({ ca });
  } catch (error) {
    throw new Error("agent_host_ca_certificate_invalid", { cause: error });
  }
  const dispatcher = new Agent({ connect: { ca } });
  const request: typeof fetch = (input, init) => {
    const requestInit: RequestInit & { dispatcher: Agent } = { ...init, dispatcher };
    return fetch(input, requestInit);
  };
  return {
    ca,
    request,
    async close() {
      await dispatcher.close();
    }
  };
}
