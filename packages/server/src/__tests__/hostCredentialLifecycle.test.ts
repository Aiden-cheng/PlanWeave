import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHostRepository } from "../hosts.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";

const directories: string[] = [];
const servers: PlanweaveServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

function token(): string {
  return `pw_host_${randomBytes(32).toString("base64url")}`;
}

async function setup(clock: () => Date): Promise<AgentHostRepository> {
  const directory = await mkdtemp(join(tmpdir(), "planweave-host-credential-lifecycle-"));
  directories.push(directory);
  const server = await startPlanweaveServer({
    dataDirectory: directory,
    databasePath: join(directory, "server.sqlite"),
    busyTimeoutMs: 5_000
  });
  servers.push(server);
  return new AgentHostRepository(server.database, clock);
}

describe("renewable Agent Host credentials", () => {
  it("keeps the current token until the pending token authenticates, then grants a short grace", async () => {
    let now = new Date("2030-01-01T00:00:00.000Z");
    const hosts = await setup(() => now);
    const currentToken = token();
    const nextToken = token();
    const registration = hosts.registerWithCredential(
      "Renewable Host",
      currentToken,
      ["linux"],
      1,
      "2030-06-30T00:00:00.000Z",
      { lifetimeDays: 180, renewal: "automatic" }
    );

    const requested = hosts.requestCredentialRenewal(registration.host.id);
    expect(requested.credentialRenewalRequestedAt).toBe(now.toISOString());
    const rotation = hosts.registerCredentialRotation(
      registration.host.id,
      "rotation-001",
      nextToken
    );
    expect(hosts.authenticateCredential(registration.host.id, currentToken)?.kind).toBe("current");
    expect(hosts.getRequired(registration.host.id).credentialRenewalRequestedAt).toBe(
      now.toISOString()
    );

    expect(hosts.authenticateCredential(registration.host.id, nextToken)?.kind).toBe("promoted");
    expect(hosts.getRequired(registration.host.id)).toMatchObject({
      credentialExpiresAt: rotation.credentialExpiresAt,
      credentialRenewalRequestedAt: undefined
    });
    expect(hosts.authenticateCredential(registration.host.id, currentToken)?.kind).toBe("previous");

    now = new Date("2030-01-01T00:10:00.001Z");
    expect(hosts.authenticateCredential(registration.host.id, currentToken)).toBeUndefined();
    expect(hosts.authenticateCredential(registration.host.id, nextToken)?.kind).toBe("current");
  });

  it("replays the exact rotation idempotently and rejects conflicts or expired renewal", async () => {
    let now = new Date("2030-01-01T00:00:00.000Z");
    const hosts = await setup(() => now);
    const registration = hosts.registerWithCredential(
      "Renewable Host",
      token(),
      [],
      1,
      "2030-01-02T00:00:00.000Z",
      { lifetimeDays: 30, renewal: "automatic" }
    );
    const nextToken = token();
    const first = hosts.registerCredentialRotation(registration.host.id, "rotation-001", nextToken);
    expect(
      hosts.registerCredentialRotation(registration.host.id, "rotation-001", nextToken)
    ).toEqual(first);
    expect(() =>
      hosts.registerCredentialRotation(registration.host.id, "rotation-002", token())
    ).toThrow("agent_host_credential_rotation_conflict");

    now = new Date("2030-01-02T00:00:00.001Z");
    expect(() => hosts.requestCredentialRenewal(registration.host.id)).toThrow(
      "agent_host_credential_expired"
    );
  });

  it("leaves legacy credentials valid but explicitly non-renewable", async () => {
    const hosts = await setup(() => new Date("2030-01-01T00:00:00.000Z"));
    const registration = hosts.register("Legacy Host");
    expect(hosts.authenticate(registration.host.id, registration.token)?.id).toBe(
      registration.host.id
    );
    expect(() => hosts.requestCredentialRenewal(registration.host.id)).toThrow(
      "agent_host_credential_renewal_not_configured"
    );
  });
});
