import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { CollaborationClient, type CollaborationWebSocketConstructor } from "../src/main/collaboration/CollaborationClient.js";
import { parseServerConfig } from "../../server/src/config.js";
import { hashOperatorToken } from "../../server/src/operatorAuth.js";
import { createDistributedServerComposition, type DistributedServerComposition } from "../../server/src/serverComposition.js";

const smokeAdminToken = "planweave_desktop_smoke_admin_token_abcdefghijklmnopqrstuvwxyz";

export type CollaborationSmokeFixture = {
  origin: string;
  projectId: string;
  invitationToken: string;
  close: () => Promise<void>;
};

type FixtureInput = {
  projectRoot: string;
  projectId: string;
};

const websocketConstructor = WebSocket as unknown as CollaborationWebSocketConstructor;

function profile(origin: string, projectId: string, profileId: string) {
  return {
    profileId,
    displayName: "Desktop smoke fixture",
    serverBaseUrl: `${origin}/`,
    projectId,
    allowInsecureTransport: true
  } as const;
}

async function listen(server: HttpServer): Promise<{ origin: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("collaboration_smoke_server_address_missing");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

/**
 * Starts the same HTTP + human-observer WebSocket composition used by the
 * collaboration server tests. The fixture is held by the smoke parent process
 * while the real Electron renderer connects through its typed bridge.
 */
export async function startCollaborationSmokeFixture(
  input: FixtureInput
): Promise<CollaborationSmokeFixture> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-desktop-collaboration-server-"));
  const httpServer = createServer();
  let composition: DistributedServerComposition | undefined;
  let serverClose: (() => Promise<void>) | undefined;
  let ownerClient: CollaborationClient | undefined;

  try {
    composition = await createDistributedServerComposition({
      httpServer,
      config: parseServerConfig({
        version: "server-config/v1",
        bind: { host: "127.0.0.1", port: 7_443 },
        publicUrl: "http://127.0.0.1:7443",
        allowInsecureDevelopment: true,
        dataDirectory,
        trustedProjects: [{ projectId: input.projectId, canvasId: "default", projectRoot: input.projectRoot }],
        operatorCredentials: [
          {
            operatorId: "desktop-smoke-admin",
            tokenSha256: hashOperatorToken(smokeAdminToken),
            projectIds: [],
            serverAdmin: true
          }
        ]
      })
    });
    const listening = await listen(httpServer);
    serverClose = listening.close;

    const anonymous = new CollaborationClient({
      profile: profile(listening.origin, input.projectId, "desktop-smoke-anonymous"),
      credential: { getDeviceToken: () => undefined }
    });
    const bootstrap = await anonymous.bootstrapOwner({
      displayName: "Desktop smoke owner",
      humanPrincipalId: "desktop-smoke-owner"
    });
    anonymous.dispose();
    if (!bootstrap.deviceToken) {
      throw new Error("collaboration_smoke_owner_credential_missing");
    }
    ownerClient = new CollaborationClient({
      profile: profile(listening.origin, input.projectId, "desktop-smoke-owner"),
      credential: { getDeviceToken: () => bootstrap.deviceToken },
      WebSocketImpl: websocketConstructor
    });
    const invitation = await ownerClient.createInvitation();

    return {
      origin: listening.origin,
      projectId: input.projectId,
      invitationToken: invitation.invitationToken,
      close: async () => {
        ownerClient?.dispose();
        ownerClient = undefined;
        await composition?.close();
        composition = undefined;
        await serverClose?.();
        serverClose = undefined;
        await rm(dataDirectory, { recursive: true, force: true });
      }
    };
  } catch (error) {
    ownerClient?.dispose();
    try {
      await composition?.close();
    } finally {
      await serverClose?.();
      await rm(dataDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}
