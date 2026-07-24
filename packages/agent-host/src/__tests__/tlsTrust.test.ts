import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentHostTlsTrust } from "../tls/trust.js";

const directories: string[] = [];
const originalTlsRejection = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

afterEach(async () => {
  if (originalTlsRejection === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalTlsRejection;
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("Agent Host TLS trust", () => {
  it("rejects globally disabled certificate verification", async () => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    await expect(createAgentHostTlsTrust()).rejects.toThrow("agent_host_tls_verification_disabled");
  });

  it("uses fixed error codes for unreadable and invalid CA files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-host-ca-"));
    directories.push(directory);
    const missing = join(directory, "private-missing-ca.pem");
    await expect(createAgentHostTlsTrust(missing)).rejects.toThrow(
      "agent_host_ca_certificate_unreadable"
    );

    const invalid = join(directory, "private-invalid-ca.pem");
    await writeFile(invalid, "not a certificate");
    await expect(createAgentHostTlsTrust(invalid)).rejects.toThrow(
      "agent_host_ca_certificate_invalid"
    );
  });
});
