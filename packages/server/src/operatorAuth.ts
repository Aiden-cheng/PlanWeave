import { createHash, timingSafeEqual } from "node:crypto";
import { opaqueIdentifierSchema, operatorTokenSchema } from "@planweave-ai/distributed-protocol";
import { z } from "zod";
import type { RemoteInteractionAuthorizationPort } from "./remoteInteractions.js";

const operatorTokenSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const operatorCredentialSchema = z
  .object({
    operatorId: opaqueIdentifierSchema,
    tokenSha256: operatorTokenSha256Schema,
    projectIds: z.array(opaqueIdentifierSchema).max(256),
    serverAdmin: z.boolean().default(false)
  })
  .strict();

export const operatorPrincipalSchema = operatorCredentialSchema.omit({ tokenSha256: true });
export type OperatorPrincipal = z.infer<typeof operatorPrincipalSchema>;
export type OperatorCredential = z.input<typeof operatorCredentialSchema>;

export function hashOperatorToken(token: string): string {
  return createHash("sha256").update(operatorTokenSchema.parse(token)).digest("hex");
}

function bearerToken(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(value ?? "");
  return match?.[1];
}

export class OperatorTokenRegistry implements RemoteInteractionAuthorizationPort {
  private readonly credentials: Array<{ principal: OperatorPrincipal; digest: Buffer }>;
  private readonly principals = new Map<string, OperatorPrincipal>();

  constructor(rawCredentials: readonly OperatorCredential[]) {
    const credentials = z.array(operatorCredentialSchema).min(1).max(1024).parse(rawCredentials);
    const tokenDigests = new Set<string>();
    this.credentials = credentials.map(({ tokenSha256, ...rawPrincipal }) => {
      const principal = operatorPrincipalSchema.parse(rawPrincipal);
      if (this.principals.has(principal.operatorId)) {
        throw new Error("operator_id_duplicate");
      }
      if (tokenDigests.has(tokenSha256)) throw new Error("operator_token_duplicate");
      this.principals.set(principal.operatorId, principal);
      tokenDigests.add(tokenSha256);
      return { principal, digest: Buffer.from(tokenSha256, "hex") };
    });
  }

  authenticate(authorization: string | string[] | undefined): OperatorPrincipal | undefined {
    const token = bearerToken(authorization);
    if (!token) return undefined;
    const digest = Buffer.from(hashOperatorToken(token), "hex");
    return this.credentials.find(
      (credential) =>
        credential.digest.length === digest.length && timingSafeEqual(credential.digest, digest)
    )?.principal;
  }

  authorizeProject(principal: OperatorPrincipal, projectId: string): void {
    if (!principal.serverAdmin && !principal.projectIds.includes(projectId)) {
      throw new Error("operator_project_forbidden");
    }
  }

  authorizeWorkspace(
    principal: OperatorPrincipal,
    workspaceId: string,
    workspaceForProject: (projectId: string) => string | undefined
  ): void {
    if (principal.serverAdmin) return;
    const allowed = principal.projectIds.some(
      (projectId) => workspaceForProject(projectId) === workspaceId
    );
    if (!allowed) throw new Error("operator_workspace_forbidden");
  }

  requireServerAdmin(principal: OperatorPrincipal): void {
    if (!principal.serverAdmin) throw new Error("operator_server_admin_required");
  }

  canRespond(input: { responderId: string; projectId: string }): boolean {
    const principal = this.principals.get(input.responderId);
    return Boolean(
      principal && (principal.serverAdmin || principal.projectIds.includes(input.projectId))
    );
  }
}
