import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  handleHumanHttpRequest,
  HumanIdentityRepository,
  HumanMembershipService,
  mintHumanDeviceToken,
  resetHumanHttpRateLimits
} from "../identity/index.js";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const servers: HttpServer[] = [];
const directories: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  resetHumanHttpRateLimits();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  for (const database of databases.splice(0)) {
    try {
      database.close();
    } catch {
      // already closed
    }
  }
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup(allowInsecureDevelopment = true) {
  const directory = await mkdtemp(join(tmpdir(), "planweave-human-http-"));
  directories.push(directory);
  const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
  databases.push(database);
  applyMigrations(database);
  const repository = new HumanIdentityRepository(database);
  const service = new HumanMembershipService({ repository });
  const server = createServer((request, response) => {
    void handleHumanHttpRequest(request, response, {
      service,
      repository,
      allowInsecureDevelopment
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    repository,
    service,
    database
  };
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function jsonHeaders(token?: string) {
  return {
    "content-type": "application/json",
    ...(token ? auth(token) : {})
  };
}

async function bootstrap(
  origin: string,
  projectId = "project-a",
  body: Record<string, unknown> = { displayName: "Ada Owner", humanPrincipalId: "human-owner-1" }
) {
  const response = await fetch(`${origin}/api/v1/projects/${projectId}/human/bootstrap`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body)
  });
  const payload = (await response.json()) as {
    error?: string;
    deviceToken?: string;
    principal?: { humanPrincipalId: string };
    membership?: { role: string };
    created?: boolean;
    device?: { deviceCredentialId: string; tokenSha256?: string };
  };
  return { response, payload };
}

describe("human membership HTTP APIs", () => {
  it("bootstraps owner on local-admin loopback and returns one-shot device token without digests", async () => {
    const { origin } = await setup();
    const first = await bootstrap(origin);
    expect(first.response.status).toBe(201);
    expect(first.payload.created).toBe(true);
    expect(first.payload.membership?.role).toBe("owner");
    expect(first.payload.deviceToken).toMatch(/^pw_hdev_/);
    expect(first.payload.device?.tokenSha256).toBeUndefined();
    expect(JSON.stringify(first.payload)).not.toContain("tokenSha256");

    const again = await bootstrap(origin);
    expect(again.response.status).toBe(200);
    expect(again.payload.created).toBe(false);
    expect(again.payload.deviceToken).toBeUndefined();

    const conflict = await bootstrap(origin, "project-a", {
      displayName: "Other",
      humanPrincipalId: "human-other"
    });
    expect(conflict.response.status).toBe(409);
    expect(conflict.payload.error).toBe("human_bootstrap_conflict");
  });

  it("rejects host/operator-shaped credentials and unknown device tokens uniformly", async () => {
    const { origin } = await setup();
    await bootstrap(origin);

    const host = await fetch(`${origin}/api/v1/projects/project-a/human/members`, {
      headers: { Authorization: "Bearer pw_host_not_a_human_device_token_value____" }
    });
    expect(host.status).toBe(401);
    await expect(host.json()).resolves.toEqual({ error: "human_auth_unauthenticated" });

    const unknown = await fetch(`${origin}/api/v1/projects/project-a/human/members`, {
      headers: auth(mintHumanDeviceToken())
    });
    expect(unknown.status).toBe(401);
    const unknownBody = await unknown.json();
    expect(unknownBody).toEqual({ error: "human_auth_unauthenticated" });
    // No distinction that a never-seen token "was once valid".
    expect(JSON.stringify(unknownBody)).not.toMatch(/revoked|expired|digest/i);
  });

  it("covers invitation create/list/revoke/consume, double consume, and role matrix", async () => {
    const { origin } = await setup();
    const owner = await bootstrap(origin);
    const ownerToken = owner.payload.deviceToken!;

    const create = await fetch(`${origin}/api/v1/projects/project-a/human/invitations`, {
      method: "POST",
      headers: jsonHeaders(ownerToken),
      body: JSON.stringify({})
    });
    expect(create.status).toBe(201);
    const invite = (await create.json()) as {
      invitationToken: string;
      invitation: { invitationId: string; tokenSha256?: string };
    };
    expect(invite.invitationToken).toMatch(/^pw_inv_/);
    expect(invite.invitation.tokenSha256).toBeUndefined();

    const listed = await fetch(`${origin}/api/v1/projects/project-a/human/invitations`, {
      headers: auth(ownerToken)
    });
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { items: Array<{ invitationId: string }> };
    expect(
      listedBody.items.some((item) => item.invitationId === invite.invitation.invitationId)
    ).toBe(true);
    expect(JSON.stringify(listedBody)).not.toContain("tokenSha256");

    const joined = await fetch(`${origin}/api/v1/projects/project-a/human/invitations/consume`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        invitationToken: invite.invitationToken,
        displayName: "Bob Member"
      })
    });
    expect(joined.status).toBe(201);
    const member = (await joined.json()) as {
      deviceToken: string;
      membership: { role: string; humanPrincipalId: string };
      principal: { humanPrincipalId: string };
    };
    expect(member.membership.role).toBe("member");
    expect(member.deviceToken).toMatch(/^pw_hdev_/);

    const double = await fetch(`${origin}/api/v1/projects/project-a/human/invitations/consume`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        invitationToken: invite.invitationToken,
        displayName: "Charlie"
      })
    });
    expect(double.status).toBe(403);
    await expect(double.json()).resolves.toEqual({ error: "human_invitation_consumed" });

    // Member cannot create invitations.
    const memberCreate = await fetch(`${origin}/api/v1/projects/project-a/human/invitations`, {
      method: "POST",
      headers: jsonHeaders(member.deviceToken),
      body: JSON.stringify({})
    });
    expect(memberCreate.status).toBe(403);
    await expect(memberCreate.json()).resolves.toEqual({ error: "human_role_insufficient" });

    // Member can list members; create another invite for revoke path.
    const members = await fetch(`${origin}/api/v1/projects/project-a/human/members`, {
      headers: auth(member.deviceToken)
    });
    expect(members.status).toBe(200);
    const membersBody = (await members.json()) as { items: Array<{ role: string }> };
    expect(membersBody.items.length).toBeGreaterThanOrEqual(2);

    const invite2 = await fetch(`${origin}/api/v1/projects/project-a/human/invitations`, {
      method: "POST",
      headers: jsonHeaders(ownerToken),
      body: JSON.stringify({})
    });
    const invite2Body = (await invite2.json()) as {
      invitation: { invitationId: string };
      invitationToken: string;
    };
    const revoked = await fetch(
      `${origin}/api/v1/projects/project-a/human/invitations/${invite2Body.invitation.invitationId}/revoke`,
      { method: "POST", headers: auth(ownerToken) }
    );
    expect(revoked.status).toBe(200);
    const revokedAgain = await fetch(
      `${origin}/api/v1/projects/project-a/human/invitations/${invite2Body.invitation.invitationId}/revoke`,
      { method: "POST", headers: auth(ownerToken) }
    );
    // Idempotent revoke returns current state.
    expect(revokedAgain.status).toBe(200);

    const consumeRevoked = await fetch(
      `${origin}/api/v1/projects/project-a/human/invitations/consume`,
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          invitationToken: invite2Body.invitationToken,
          displayName: "Eve"
        })
      }
    );
    expect(consumeRevoked.status).toBe(403);
    await expect(consumeRevoked.json()).resolves.toEqual({ error: "human_invitation_revoked" });
  });

  it("enforces project isolation for device tokens and memberships", async () => {
    const { origin } = await setup();
    const a = await bootstrap(origin, "project-a", {
      displayName: "Owner A",
      humanPrincipalId: "owner-a"
    });
    const b = await bootstrap(origin, "project-b", {
      displayName: "Owner B",
      humanPrincipalId: "owner-b"
    });

    const cross = await fetch(`${origin}/api/v1/projects/project-b/human/members`, {
      headers: auth(a.payload.deviceToken!)
    });
    expect(cross.status).toBe(401);
    await expect(cross.json()).resolves.toEqual({ error: "human_auth_unauthenticated" });

    const own = await fetch(`${origin}/api/v1/projects/project-b/human/members`, {
      headers: auth(b.payload.deviceToken!)
    });
    expect(own.status).toBe(200);
  });

  it("prevents project-a owner from revoking a project-b-only device credential", async () => {
    const { origin } = await setup();
    const a = await bootstrap(origin, "project-a", {
      displayName: "Owner A",
      humanPrincipalId: "owner-a"
    });
    const b = await bootstrap(origin, "project-b", {
      displayName: "Owner B",
      humanPrincipalId: "owner-b"
    });
    const foreignDeviceId = b.payload.device!.deviceCredentialId;

    const crossRevoke = await fetch(
      `${origin}/api/v1/projects/project-a/human/devices/${foreignDeviceId}/revoke`,
      { method: "POST", headers: auth(a.payload.deviceToken!) }
    );
    expect(crossRevoke.status).toBe(403);
    await expect(crossRevoke.json()).resolves.toEqual({ error: "human_membership_required" });

    // Foreign owner device remains usable on its own project.
    const stillAuth = await fetch(`${origin}/api/v1/projects/project-b/human/members`, {
      headers: auth(b.payload.deviceToken!)
    });
    expect(stillAuth.status).toBe(200);
  });

  it("recovers owner access via loopback re-bootstrap after last device is revoked", async () => {
    const { origin } = await setup();
    const first = await bootstrap(origin, "project-a", {
      displayName: "Ada Owner",
      humanPrincipalId: "human-owner-1"
    });
    expect(first.response.status).toBe(201);
    const firstToken = first.payload.deviceToken!;
    const firstDeviceId = first.payload.device!.deviceCredentialId;

    const revoked = await fetch(
      `${origin}/api/v1/projects/project-a/human/devices/${firstDeviceId}/revoke`,
      { method: "POST", headers: auth(firstToken) }
    );
    expect(revoked.status).toBe(200);

    const lockedOut = await fetch(`${origin}/api/v1/projects/project-a/human/members`, {
      headers: auth(firstToken)
    });
    expect(lockedOut.status).toBe(401);

    const recovered = await bootstrap(origin, "project-a", {
      displayName: "Ada Owner",
      humanPrincipalId: "human-owner-1"
    });
    expect(recovered.response.status).toBe(200);
    expect(recovered.payload.created).toBe(false);
    expect(recovered.payload.deviceToken).toMatch(/^pw_hdev_/);
    expect(recovered.payload.device?.deviceCredentialId).not.toBe(firstDeviceId);

    const members = await fetch(`${origin}/api/v1/projects/project-a/human/members`, {
      headers: auth(recovered.payload.deviceToken!)
    });
    expect(members.status).toBe(200);
  });

  it("protects last owner and supports promote/demote/remove", async () => {
    const { origin } = await setup();
    const owner = await bootstrap(origin);
    const ownerToken = owner.payload.deviceToken!;

    const inviteRes = await fetch(`${origin}/api/v1/projects/project-a/human/invitations`, {
      method: "POST",
      headers: jsonHeaders(ownerToken),
      body: JSON.stringify({})
    });
    const invite = (await inviteRes.json()) as { invitationToken: string };
    const joinRes = await fetch(`${origin}/api/v1/projects/project-a/human/invitations/consume`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ invitationToken: invite.invitationToken, displayName: "Bob" })
    });
    const member = (await joinRes.json()) as {
      deviceToken: string;
      principal: { humanPrincipalId: string };
    };

    const lastOwnerRemove = await fetch(
      `${origin}/api/v1/projects/project-a/human/members/${owner.payload.principal!.humanPrincipalId}/remove`,
      { method: "POST", headers: auth(ownerToken) }
    );
    expect(lastOwnerRemove.status).toBe(403);
    await expect(lastOwnerRemove.json()).resolves.toEqual({ error: "human_last_owner_protected" });

    const lastOwnerDemote = await fetch(
      `${origin}/api/v1/projects/project-a/human/members/${owner.payload.principal!.humanPrincipalId}/demote`,
      { method: "POST", headers: auth(ownerToken) }
    );
    expect(lastOwnerDemote.status).toBe(403);
    await expect(lastOwnerDemote.json()).resolves.toEqual({ error: "human_last_owner_protected" });

    const promoted = await fetch(
      `${origin}/api/v1/projects/project-a/human/members/${member.principal.humanPrincipalId}/promote`,
      { method: "POST", headers: auth(ownerToken) }
    );
    expect(promoted.status).toBe(200);
    await expect(promoted.json()).resolves.toMatchObject({ role: "owner" });

    // Idempotent promote
    const promotedAgain = await fetch(
      `${origin}/api/v1/projects/project-a/human/members/${member.principal.humanPrincipalId}/promote`,
      { method: "POST", headers: auth(ownerToken) }
    );
    expect(promotedAgain.status).toBe(200);

    const demoted = await fetch(
      `${origin}/api/v1/projects/project-a/human/members/${member.principal.humanPrincipalId}/demote`,
      { method: "POST", headers: auth(ownerToken) }
    );
    expect(demoted.status).toBe(200);
    await expect(demoted.json()).resolves.toMatchObject({ role: "member" });

    // Member cannot remove other members
    const memberRemoveOwner = await fetch(
      `${origin}/api/v1/projects/project-a/human/members/${owner.payload.principal!.humanPrincipalId}/remove`,
      { method: "POST", headers: auth(member.deviceToken) }
    );
    expect(memberRemoveOwner.status).toBe(403);

    const removed = await fetch(
      `${origin}/api/v1/projects/project-a/human/members/${member.principal.humanPrincipalId}/remove`,
      { method: "POST", headers: auth(ownerToken) }
    );
    expect(removed.status).toBe(200);

    const after = await fetch(`${origin}/api/v1/projects/project-a/human/members`, {
      headers: auth(member.deviceToken)
    });
    expect(after.status).toBe(401);
  });

  it("lists and revokes devices; revoked tokens cannot authenticate", async () => {
    const { origin, repository } = await setup();
    const boot = await bootstrap(origin, "project-ttl", {
      displayName: "Ada",
      humanPrincipalId: "owner-ttl"
    });
    const ownerToken = boot.payload.deviceToken!;
    const ownerDeviceId = boot.payload.device!.deviceCredentialId;

    const ownDevices = await fetch(
      `${origin}/api/v1/projects/project-ttl/human/devices?scope=own`,
      { headers: auth(ownerToken) }
    );
    expect(ownDevices.status).toBe(200);
    const ownBody = (await ownDevices.json()) as {
      items: Array<{ deviceCredentialId: string; tokenSha256?: string }>;
    };
    expect(ownBody.items.some((item) => item.deviceCredentialId === ownerDeviceId)).toBe(true);
    expect(JSON.stringify(ownBody)).not.toContain("tokenSha256");

    const projectDevices = await fetch(
      `${origin}/api/v1/projects/project-ttl/human/devices?scope=project`,
      { headers: auth(ownerToken) }
    );
    expect(projectDevices.status).toBe(200);

    // Mint a member device so owner can revoke another credential without killing the session.
    const inviteRes = await fetch(`${origin}/api/v1/projects/project-ttl/human/invitations`, {
      method: "POST",
      headers: jsonHeaders(ownerToken),
      body: JSON.stringify({})
    });
    const invite = (await inviteRes.json()) as { invitationToken: string };
    const joinRes = await fetch(`${origin}/api/v1/projects/project-ttl/human/invitations/consume`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ invitationToken: invite.invitationToken, displayName: "Bob" })
    });
    const member = (await joinRes.json()) as {
      deviceToken: string;
      device: { deviceCredentialId: string };
    };

    const revoked = await fetch(
      `${origin}/api/v1/projects/project-ttl/human/devices/${member.device.deviceCredentialId}/revoke`,
      { method: "POST", headers: auth(ownerToken) }
    );
    expect(revoked.status).toBe(200);

    // Idempotent while the acting owner session remains valid.
    const revokedAgain = await fetch(
      `${origin}/api/v1/projects/project-ttl/human/devices/${member.device.deviceCredentialId}/revoke`,
      { method: "POST", headers: auth(ownerToken) }
    );
    expect(revokedAgain.status).toBe(200);

    const afterRevoke = await fetch(`${origin}/api/v1/projects/project-ttl/human/members`, {
      headers: auth(member.deviceToken)
    });
    expect(afterRevoke.status).toBe(401);

    const short = repository.bootstrapOwner({
      kind: "local_administrative_proof",
      projectId: "project-exp",
      humanPrincipalId: "owner-exp",
      displayName: "Exp",
      issuedAt: "2026-07-24T10:00:00.000Z"
    });
    expect(short.deviceToken).toBeDefined();
    repository.revokeDevice(short.device.deviceCredentialId);
    const expiredAuth = await fetch(`${origin}/api/v1/projects/project-exp/human/members`, {
      headers: auth(short.deviceToken!)
    });
    expect(expiredAuth.status).toBe(401);
    await expect(expiredAuth.json()).resolves.toEqual({ error: "human_auth_unauthenticated" });
  });

  it("rejects malformed and oversized bodies, invalid query, and insecure transport", async () => {
    const secure = await setup(false);
    const insecure = await fetch(`${secure.origin}/api/v1/projects/project-a/human/bootstrap`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ displayName: "Ada" })
    });
    expect(insecure.status).toBe(426);
    await expect(insecure.json()).resolves.toEqual({ error: "human_insecure_transport" });

    const { origin } = await setup(true);
    const malformed = await fetch(`${origin}/api/v1/projects/project-a/human/bootstrap`, {
      method: "POST",
      headers: jsonHeaders(),
      body: "{"
    });
    expect(malformed.status).toBe(400);

    const oversized = await fetch(`${origin}/api/v1/projects/project-a/human/bootstrap`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ displayName: "x".repeat(20_000) })
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({ error: "human_body_too_large" });

    const owner = await bootstrap(origin);
    const badQuery = await fetch(
      `${origin}/api/v1/projects/project-a/human/members?limit=1&limit=2`,
      { headers: auth(owner.payload.deviceToken!) }
    );
    expect(badQuery.status).toBe(400);
  });

  it("does not treat cookie credentials as authentication and keeps mutation JSON boundary", async () => {
    const { origin } = await setup();
    const owner = await bootstrap(origin);
    const cookieOnly = await fetch(`${origin}/api/v1/projects/project-a/human/members`, {
      headers: {
        Cookie: `deviceToken=${owner.payload.deviceToken}`
      }
    });
    expect(cookieOnly.status).toBe(401);

    const formPost = await fetch(`${origin}/api/v1/projects/project-a/human/invitations`, {
      method: "POST",
      headers: {
        ...auth(owner.payload.deviceToken!),
        "content-type": "application/x-www-form-urlencoded"
      },
      body: "ttlMs=60000"
    });
    expect(formPost.status).toBe(400);
  });
});
