import {
  canvasScopeRefSchema,
  type ActorRef,
  type CanvasScopeRef
} from "@planweave-ai/collaboration-contracts";
import type { ProjectAccessRepository } from "./projectAccessRepository.js";
import type { TrustedRuntimeRegistry } from "./runtimeProjectRegistry.js";

/**
 * Main-process control seam for the exact project/canvas scopes trusted by one
 * running Server. It exposes opaque scope IDs only; storage and runtime paths
 * remain inside the composition.
 */
export interface TrustedProjectControlPort {
  listTrustedProjectScopes(): readonly CanvasScopeRef[];
  resolveTrustedProjectScope(rawScope: unknown): CanvasScopeRef | undefined;
  assertTrustedProjectAdministration(actor: ActorRef, rawScope: unknown): CanvasScopeRef;
}

export function createTrustedProjectControlPort(input: {
  runtimeRegistry: Pick<TrustedRuntimeRegistry, "expansions">;
  projectAccess: ProjectAccessRepository;
}): TrustedProjectControlPort {
  const configuredScopes = new Map<string, CanvasScopeRef>();
  for (const expansion of input.runtimeRegistry.expansions) {
    const scope = canvasScopeRefSchema.parse({
      workspaceId: expansion.workspaceId,
      projectId: expansion.projectId,
      canvasId: expansion.canvasId
    });
    configuredScopes.set(scopeKey(scope), scope);
  }

  const resolveTrustedProjectScope = (rawScope: unknown): CanvasScopeRef | undefined => {
    const scope = canvasScopeRefSchema.parse(rawScope);
    const configured = configuredScopes.get(scopeKey(scope));
    if (!configured) return undefined;
    const project = input.projectAccess.registry.projectInternal(scope.workspaceId, scope.projectId);
    const canvas = input.projectAccess.registry.canvasInternal(
      scope.workspaceId,
      scope.projectId,
      scope.canvasId
    );
    if (!project || project.revokedAt !== null || !canvas || canvas.revokedAt !== null) {
      return undefined;
    }
    return configured;
  };

  return {
    listTrustedProjectScopes() {
      return [...configuredScopes.values()].flatMap((scope) => {
        const resolved = resolveTrustedProjectScope(scope);
        return resolved ? [resolved] : [];
      });
    },
    resolveTrustedProjectScope,
    assertTrustedProjectAdministration(actor, rawScope) {
      const scope = resolveTrustedProjectScope(rawScope);
      if (!scope) throw new Error("loopback_trusted_project_scope_not_found");
      input.projectAccess.policy.assertCapability({
        ...scope,
        actor,
        capability: "administration"
      });
      return scope;
    }
  };
}

function scopeKey(scope: CanvasScopeRef): string {
  return `${scope.workspaceId}\0${scope.projectId}\0${scope.canvasId}`;
}
