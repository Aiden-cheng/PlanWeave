import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, CopyIcon, WifiIcon } from "lucide-react";
import type { LoopbackTrustedProjectScope } from "@planweave-ai/collaboration-protocol/loopback";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type {
  LocalCollaborationServerStatus,
  LocalCollaborationScope,
  LocalCollaborationScopeCatalog,
  PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";
import type { createTranslator } from "../i18n";
import type { DesktopUiSettings } from "../types";
import { serializeCollaborationInvitationHandoff } from "../team/collaborationInvitationHandoff";
import { collaborationErrorMessage } from "./formatCollaborationError";

function scopeKey(scope: LocalCollaborationScope): string {
  return `${scope.projectId}\0${scope.canvasId}`;
}

function selectedScopes(catalog: LocalCollaborationScopeCatalog): LocalCollaborationScope[] {
  return catalog.projects.flatMap((project) =>
    project.canvases
      .filter((canvas) => canvas.selected)
      .map((canvas) => ({ projectId: project.projectId, canvasId: canvas.canvasId }))
  );
}

function isInvitationRateLimited(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const boundaryError = error as { code?: unknown; kind?: unknown };
  return boundaryError.code === "human_rate_limited" || boundaryError.kind === "rate_limited";
}

function isInvitationCapacityExceeded(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { code?: unknown }).code === "human_limit_exceeded";
}

type LocalCollaborationPanelError = {
  message: string;
  action?: "manage_invitations";
};

export function LocalCollaborationServerPanel({
  api,
  t,
  projectId,
  canvasId,
  scopeLayout,
  onScopeLayoutChange,
  copyText,
  invitationHandoff,
  onInvitationHandoffChange,
  onManageInvitations,
  onStatusChange
}: {
  api: PlanWeaveCollaborationApi | null;
  t: ReturnType<typeof createTranslator>;
  projectId: string | null;
  canvasId: string | null;
  scopeLayout: DesktopUiSettings["layout"]["collaborationScope"];
  onScopeLayoutChange: (patch: Partial<DesktopUiSettings["layout"]["collaborationScope"]>) => void;
  copyText: (text: string) => Promise<void>;
  invitationHandoff: string | null;
  onInvitationHandoffChange: (handoff: string | null) => void;
  onManageInvitations?: () => void;
  onStatusChange?: (status: LocalCollaborationServerStatus) => void;
}) {
  const [status, setStatus] = useState<LocalCollaborationServerStatus | null>(null);
  const [catalog, setCatalog] = useState<LocalCollaborationScopeCatalog | null>(null);
  const [draftScopes, setDraftScopes] = useState<LocalCollaborationScope[]>([]);
  const [scopes, setScopes] = useState<readonly LoopbackTrustedProjectScope[]>([]);
  const [error, setError] = useState<LocalCollaborationPanelError | null>(null);
  const [busy, setBusy] = useState(false);
  const [invitationCopied, setInvitationCopied] = useState(false);
  const [invitationBusy, setInvitationBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const [nextStatus, nextCatalog] = await Promise.all([
        api.getLocalCollaborationServerStatus(),
        api.getLocalCollaborationScopeCatalog()
      ]);
      setStatus(nextStatus);
      onStatusChange?.(nextStatus);
      setCatalog(nextCatalog);
      setDraftScopes(selectedScopes(nextCatalog));
      setScopes(
        nextStatus.state === "running" ? await api.listLocalCollaborationTrustedScopes() : []
      );
      setError(null);
    } catch (caught) {
      setError({ message: collaborationErrorMessage(caught) });
    }
  }, [api, onStatusChange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!catalog) return;
    const projectIds = new Set(catalog.projects.map((project) => project.projectId));
    const validExpandedProjectIds = scopeLayout.expandedProjectIds.filter((projectId) =>
      projectIds.has(projectId)
    );
    if (validExpandedProjectIds.length !== scopeLayout.expandedProjectIds.length) {
      onScopeLayoutChange({ expandedProjectIds: validExpandedProjectIds });
    }
  }, [catalog, onScopeLayoutChange, scopeLayout.expandedProjectIds]);

  const savedScopes = useMemo(() => (catalog ? selectedScopes(catalog) : []), [catalog]);
  const savedScopeKeys = useMemo(() => new Set(savedScopes.map(scopeKey)), [savedScopes]);
  const draftScopeKeys = useMemo(() => new Set(draftScopes.map(scopeKey)), [draftScopes]);
  const expandedProjectIds = useMemo(
    () => new Set(scopeLayout.expandedProjectIds),
    [scopeLayout.expandedProjectIds]
  );
  const scopeChanged =
    savedScopeKeys.size !== draftScopeKeys.size ||
    [...savedScopeKeys].some((key) => !draftScopeKeys.has(key));
  const invitationScope = useMemo(() => {
    const currentSelectedScope = savedScopes.find(
      (scope) => scope.projectId === projectId && scope.canvasId === canvasId
    );
    if (currentSelectedScope) return currentSelectedScope;
    return savedScopes.length === 1 ? savedScopes[0]! : null;
  }, [canvasId, projectId, savedScopes]);
  const currentCanvasIsSelected =
    projectId !== null &&
    canvasId !== null &&
    savedScopeKeys.has(scopeKey({ projectId, canvasId }));
  const currentScope = scopes.find(
    (scope) => scope.projectId === projectId && scope.canvasId === canvasId
  );

  const prepareInvitation = useCallback(async () => {
    if (!api || !status?.lanServerBaseUrl || !invitationScope) return;
    const idempotencyKey = globalThis.crypto.randomUUID();
    setInvitationBusy(true);
    setInvitationCopied(false);
    try {
      const registration = await api.registerLocalCollaborationCurrentProject({
        selection: invitationScope
      });
      const created = await api.createCollaborationInvitation({ idempotencyKey });
      const handoff = serializeCollaborationInvitationHandoff({
        serverBaseUrl: status.lanServerBaseUrl,
        projectId: registration.projectId,
        invitationToken: created.invitationToken,
        allowInsecureTransport: new URL(status.lanServerBaseUrl).protocol === "http:"
      });
      onInvitationHandoffChange(handoff);
      setError(null);
    } catch (caught) {
      setError(
        isInvitationCapacityExceeded(caught)
          ? {
              message: t("localServerInvitationCapacityExceeded"),
              action: "manage_invitations"
            }
          : {
              message: isInvitationRateLimited(caught)
                ? t("localServerInvitationRateLimited")
                : collaborationErrorMessage(caught)
            }
      );
    } finally {
      setInvitationBusy(false);
    }
  }, [api, invitationScope, onInvitationHandoffChange, status?.lanServerBaseUrl, t]);

  if (!api) return null;
  const running = status?.state === "running";
  const lanSharingEnabled = status?.lanSharingEnabled ?? false;
  const lanAvailable = running && lanSharingEnabled && status?.lanServerBaseUrl !== null;
  const statusLabel =
    status?.state === "error"
      ? status.reason === "stop_failed"
        ? t("localServerStopFailed")
        : status.reason === "unavailable"
          ? t("localServerUnavailable")
          : t("localServerStartFailed")
      : lanAvailable
        ? t("localServerLanEnabled")
        : t("localServerLanDisabled");

  const toggleScope = (scope: LocalCollaborationScope) => {
    const key = scopeKey(scope);
    setDraftScopes((current) =>
      current.some((item) => scopeKey(item) === key)
        ? current.filter((item) => scopeKey(item) !== key)
        : [...current, scope]
    );
  };

  const toggleProject = (projectId: string) => {
    const next = new Set(scopeLayout.expandedProjectIds);
    if (next.has(projectId)) {
      next.delete(projectId);
    } else {
      next.add(projectId);
    }
    onScopeLayoutChange({ expandedProjectIds: [...next] });
  };

  const applyScopes = async () => {
    const next = await api.setLocalCollaborationTrustedScopes({ scopes: draftScopes });
    setCatalog(next);
    setDraftScopes(selectedScopes(next));
  };

  const applyScopeChanges = async () => {
    setBusy(true);
    try {
      await applyScopes();
      await refresh();
    } catch (caught) {
      setError({ message: collaborationErrorMessage(caught) });
    } finally {
      setBusy(false);
    }
  };

  const setLanSharing = async (enabled: boolean) => {
    setBusy(true);
    onInvitationHandoffChange(null);
    setInvitationCopied(false);
    try {
      const nextStatus = await api.setLocalCollaborationLanSharing({ enabled });
      setStatus(nextStatus);
      onStatusChange?.(nextStatus);
      await refresh();
    } catch (caught) {
      setError({ message: collaborationErrorMessage(caught) });
    } finally {
      setBusy(false);
    }
  };

  const copyLanAddress = async () => {
    if (!status?.lanServerBaseUrl) return;
    setBusy(true);
    try {
      await copyText(status.lanServerBaseUrl);
      setError(null);
    } catch (caught) {
      setError({ message: collaborationErrorMessage(caught) });
    } finally {
      setBusy(false);
    }
  };

  const copyInvitation = async () => {
    if (!invitationHandoff) return;
    setInvitationBusy(true);
    setInvitationCopied(false);
    try {
      await copyText(invitationHandoff);
      setInvitationCopied(true);
      setError(null);
    } catch (caught) {
      setError({ message: collaborationErrorMessage(caught) });
    } finally {
      setInvitationBusy(false);
    }
  };

  return (
    <section
      className="pb-7"
      data-testid="local-collaboration-server-panel"
      aria-labelledby="local-collaboration-server-title"
    >
      <div className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 px-1 pb-5 sm:grid-cols-[2rem_minmax(0,1fr)_auto]">
        <div
          className="flex size-8 items-center justify-center text-emerald-700 dark:text-emerald-300"
          data-testid="local-collaboration-section-icon"
        >
          <WifiIcon className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 pt-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h2
              id="local-collaboration-server-title"
              className="text-base font-semibold tracking-tight text-text-strong"
            >
              {t("localServerTitle")}
            </h2>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                lanAvailable
                  ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
                  : "bg-muted text-muted-foreground"
              }`}
              data-testid="local-collaboration-server-status"
            >
              <span
                className={`size-1.5 rounded-full ${lanAvailable ? "bg-emerald-500" : "bg-muted-foreground/50"}`}
              />
              {statusLabel}
            </span>
          </div>
          <p className="mt-1.5 max-w-2xl text-xs leading-5 text-muted-foreground">
            {t("localServerDescription")}
          </p>
        </div>
        <div className="col-start-2 mt-4 flex shrink-0 items-center gap-3 sm:col-start-3 sm:row-start-1 sm:mt-0 sm:justify-end">
          <span className="text-xs font-medium text-muted-foreground">
            {t("localServerLanToggle")}
          </span>
          <Switch
            checked={lanSharingEnabled}
            disabled={busy || status === null}
            aria-label={t("localServerLanToggle")}
            onCheckedChange={(checked) => void setLanSharing(checked)}
          />
        </div>
      </div>

      {lanSharingEnabled ? (
        <div className="border-t border-border/70 px-1 py-5 sm:ml-11">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-text-strong">
                {t("localServerLanAddress")}
              </div>
              {status?.lanServerBaseUrl ? (
                <code className="mt-1 block truncate font-mono text-xs text-emerald-700 dark:text-emerald-300">
                  {status.lanServerBaseUrl}
                </code>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">{t("localServerLanNoScope")}</p>
              )}
            </div>
            {status?.lanServerBaseUrl ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || invitationBusy}
                  onClick={() => void prepareInvitation()}
                >
                  <CopyIcon className="size-3.5" aria-hidden="true" />
                  {invitationBusy
                    ? t("localServerPreparingInvitation")
                    : t("localServerRetryInvitation")}
                </Button>
                {invitationHandoff ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy || invitationBusy}
                    onClick={() => void copyInvitation()}
                  >
                    {t("localServerCopyInvitation")}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy || invitationBusy}
                  onClick={() => void copyLanAddress()}
                >
                  {t("localServerCopyAddress")}
                </Button>
              </div>
            ) : null}
          </div>
          <p className="mt-2 max-w-3xl text-[11px] leading-4 text-muted-foreground">
            {t("localServerLanHint")}
          </p>
          {invitationHandoff ? (
            <div className="mt-4 border-l-2 border-emerald-500 bg-emerald-500/5 px-3 py-3">
              <div className="text-xs font-semibold text-text-strong">
                {t("localServerInvitationReady")}
              </div>
              <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                {t("localServerInvitationReadyHint")}
              </p>
              <textarea
                className="mt-3 min-h-20 w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px] leading-4 text-text-strong outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t("localServerInvitationReady")}
                readOnly
                value={invitationHandoff}
                onFocus={(event) => event.currentTarget.select()}
              />
              <div
                className="mt-2 text-[11px] font-medium text-emerald-700 dark:text-emerald-300"
                aria-live="polite"
              >
                {invitationCopied ? t("localServerInvitationCopied") : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="border-y border-border/70 px-1 py-5 sm:ml-11">
        <button
          type="button"
          className="flex w-full items-start gap-3 text-left outline-none transition-colors hover:text-text-strong focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={!scopeLayout.collapsed}
          aria-controls="local-collaboration-scope-catalog"
          aria-label={t(
            scopeLayout.collapsed ? "localServerScopeExpand" : "localServerScopeCollapse"
          )}
          onClick={() => onScopeLayoutChange({ collapsed: !scopeLayout.collapsed })}
        >
          {scopeLayout.collapsed ? (
            <ChevronRightIcon
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          ) : (
            <ChevronDownIcon
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          )}
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-text-strong">
              {t("localServerScopeTitle")}
            </span>
            <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
              {t("localServerScopeHint")}
            </span>
          </span>
          <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
            {t("localServerSelectedCount").replace("{count}", String(draftScopes.length))}
          </span>
        </button>

        {!scopeLayout.collapsed ? (
          <div
            id="local-collaboration-scope-catalog"
            className="mt-5 border-t border-border/70"
            data-testid="local-collaboration-scope-catalog"
          >
            {catalog?.projects.map((project, projectIndex) => {
              const projectCollapsed = !expandedProjectIds.has(project.projectId);
              const projectContentId = `local-collaboration-project-${projectIndex}`;
              return (
                <div key={project.projectId} className="border-b border-border/70">
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 px-1 py-4 text-left outline-none transition-colors hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    aria-expanded={!projectCollapsed}
                    aria-controls={projectContentId}
                    aria-label={t(
                      projectCollapsed ? "localServerProjectExpand" : "localServerProjectCollapse"
                    ).replace("{project}", project.name)}
                    onClick={() => toggleProject(project.projectId)}
                  >
                    {projectCollapsed ? (
                      <ChevronRightIcon
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    ) : (
                      <ChevronDownIcon
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-strong">
                      {project.name}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {
                        project.canvases.filter((canvas) =>
                          draftScopeKeys.has(
                            scopeKey({ projectId: project.projectId, canvasId: canvas.canvasId })
                          )
                        ).length
                      }
                      /{project.canvases.length}
                    </span>
                  </button>
                  {!projectCollapsed ? (
                    <div
                      id={projectContentId}
                      className="divide-y divide-border/40 border-t border-border/50"
                    >
                      {project.canvases.map((canvas) => {
                        const scope = { projectId: project.projectId, canvasId: canvas.canvasId };
                        const checked = draftScopeKeys.has(scopeKey(scope));
                        return (
                          <label
                            key={canvas.canvasId}
                            className="flex cursor-pointer items-center gap-3 py-3 pl-8 pr-1 hover:bg-muted/30"
                          >
                            <input
                              type="checkbox"
                              className="size-4 rounded border-border accent-emerald-600"
                              checked={checked}
                              disabled={busy}
                              onChange={() => toggleScope(scope)}
                              aria-label={`${project.name} / ${canvas.name}`}
                            />
                            <span className="min-w-0 flex-1 truncate text-sm text-text-strong">
                              {canvas.name}
                            </span>
                            {canvas.current ? (
                              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                                {t("localServerCurrentCanvas")}
                              </span>
                            ) : null}
                            <span
                              className={`text-[10px] ${checked ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground"}`}
                            >
                              {checked ? t("localServerHosted") : t("localServerPrivate")}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {catalog && catalog.projects.length === 0 ? (
              <p className="border-b border-border/70 py-8 text-center text-sm text-muted-foreground">
                {t("localServerNoProjects")}
              </p>
            ) : null}
          </div>
        ) : null}

        {scopeChanged ? (
          <div className="mt-4 flex items-center justify-between gap-3 border-l-2 border-amber-500 bg-amber-500/5 px-3 py-2.5">
            <span className="text-[11px] text-amber-900 dark:text-amber-200">
              {t("localServerScopeChanged")}
            </span>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => void applyScopeChanges()}
            >
              {t("localServerApplyScopes")}
            </Button>
          </div>
        ) : null}

        {running && currentCanvasIsSelected ? (
          <div
            className="mt-5 border-t border-border/50 pt-4"
            data-testid="local-collaboration-current-canvas-status"
          >
            <div>
              <div className="text-[11px] font-medium text-text-strong">
                {t("localServerCurrentCanvasReady")}
              </div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">
                {currentScope
                  ? `${currentScope.projectId} / ${currentScope.canvasId}`
                  : t("localServerOwnerPending")}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {error ? (
        <div
          className="flex items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/5 px-1 py-3 text-xs text-destructive sm:ml-11"
          role="alert"
        >
          <span>{error.message}</span>
          {error.action === "manage_invitations" && onManageInvitations ? (
            <Button type="button" size="sm" variant="outline" onClick={onManageInvitations}>
              {t("localServerManageInvitations")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
