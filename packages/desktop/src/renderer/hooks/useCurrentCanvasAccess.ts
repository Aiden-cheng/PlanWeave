import { useCallback, useEffect, useState } from "react";
import type {
  ActiveCanvasPersonGrant,
  ActiveWorkspaceConnectionStatus,
  AccessMutationResult,
  CurrentCanvasAccessView
} from "@planweave-ai/collaboration-contracts";
import { collaborationErrorMessage } from "../collaboration/formatCollaborationError";
import type {
  CollaborationAccessMutationInput,
  PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";

export type CurrentCanvasAccessApi = Pick<
  PlanWeaveCollaborationApi,
  "getCurrentCanvasAccess" | "mutateCurrentCanvasAccess"
>;

export type UseCurrentCanvasAccessArgs = {
  api: CurrentCanvasAccessApi | null;
  canvasId: string | null | undefined;
  status: { workspaceConnection: { status: ActiveWorkspaceConnectionStatus } } | null;
};

export type CurrentCanvasVisibilityScope = "project" | "canvas";

export type UseCurrentCanvasAccessResult = {
  view: CurrentCanvasAccessView | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  refresh: () => Promise<void>;
  updateVisibility: (
    scopeKind: CurrentCanvasVisibilityScope,
    visibility: "private" | "shared"
  ) => Promise<AccessMutationResult | null>;
  grant: (
    humanPrincipalId: CurrentCanvasAccessView["people"][number]["humanPrincipalId"],
    role: "viewer" | "editor",
    scopeKind: CurrentCanvasVisibilityScope
  ) => Promise<AccessMutationResult | null>;
  revoke: (grant: ActiveCanvasPersonGrant) => Promise<AccessMutationResult | null>;
};

function canLoadCurrentCanvasAccess(args: UseCurrentCanvasAccessArgs): args is UseCurrentCanvasAccessArgs & {
  api: CurrentCanvasAccessApi;
  canvasId: string;
} {
  return (
    args.api !== null &&
    typeof args.canvasId === "string" &&
    args.canvasId.length > 0 &&
    args.status?.workspaceConnection.status === "connected"
  );
}

/** Current-canvas ACL state is authoritative only when main has an explicit Workspace connection. */
export function useCurrentCanvasAccess(
  args: UseCurrentCanvasAccessArgs
): UseCurrentCanvasAccessResult {
  const { api, canvasId, status } = args;
  const workspaceConnectionStatus = status?.workspaceConnection.status ?? "local_only";
  const [view, setView] = useState<CurrentCanvasAccessView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const currentArgs = {
      api,
      canvasId,
      status: { workspaceConnection: { status: workspaceConnectionStatus } }
    };
    if (!canLoadCurrentCanvasAccess(currentArgs)) {
      setView(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setView(await currentArgs.api.getCurrentCanvasAccess({ canvasId: currentArgs.canvasId }));
    } catch (nextError) {
      setView(null);
      setError(collaborationErrorMessage(nextError));
    } finally {
      setLoading(false);
    }
  }, [api, canvasId, workspaceConnectionStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mutate = useCallback(
    async (request: CollaborationAccessMutationInput["request"]): Promise<AccessMutationResult | null> => {
      const currentArgs = {
        api,
        canvasId,
        status: { workspaceConnection: { status: workspaceConnectionStatus } }
      };
      if (!canLoadCurrentCanvasAccess(currentArgs) || !view || busy) return null;
      const input: CollaborationAccessMutationInput = {
        canvasId: view.scope.canvasId,
        request
      };
      setBusy(true);
      setError(null);
      try {
        const result = await currentArgs.api.mutateCurrentCanvasAccess(input);
        if (result.status === "conflict") {
          setError(result.reason);
        } else if (result.status === "denied") {
          setError(result.reason);
        }
        await refresh();
        return result;
      } catch (nextError) {
        setError(collaborationErrorMessage(nextError));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [api, busy, canvasId, refresh, view, workspaceConnectionStatus]
  );

  const scopeFor = useCallback(
    (scopeKind: CurrentCanvasVisibilityScope) => {
      if (!view) return null;
      return scopeKind === "project"
        ? {
            scope: {
              scopeKind: "project" as const,
              workspaceId: view.scope.workspaceId,
              projectId: view.scope.projectId,
              canvasId: null
            },
            expectedAclRevision: view.projectAclRevision
          }
        : { scope: view.scope, expectedAclRevision: view.canvasAclRevision };
    },
    [view]
  );

  const updateVisibility = useCallback(
    async (scopeKind: CurrentCanvasVisibilityScope, visibility: "private" | "shared") => {
      const target = scopeFor(scopeKind);
      return target
        ? mutate({ operation: "visibility", ...target, visibility })
        : null;
    },
    [mutate, scopeFor]
  );

  const grant = useCallback(
    async (
      humanPrincipalId: CurrentCanvasAccessView["people"][number]["humanPrincipalId"],
      role: "viewer" | "editor",
      scopeKind: CurrentCanvasVisibilityScope
    ) => {
      const target = scopeFor(scopeKind);
      return target ? mutate({ operation: "grant", ...target, humanPrincipalId, role }) : null;
    },
    [mutate, scopeFor]
  );

  const revoke = useCallback(
    async (grantToRevoke: ActiveCanvasPersonGrant) => {
      const target = scopeFor(grantToRevoke.scopeKind);
      return target ? mutate({ operation: "revoke", ...target, grantId: grantToRevoke.grantId }) : null;
    },
    [mutate, scopeFor]
  );

  return { view, loading, error, busy, refresh, updateVisibility, grant, revoke };
}
