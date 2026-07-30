import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2Icon, ChevronDownIcon, ChevronRightIcon, LaptopIcon } from "lucide-react";
import type {
  LoopbackProjectRegistrationView,
  LoopbackServerStatus,
  LoopbackTrustedProjectScope
} from "@planweave-ai/collaboration-contracts";
import { Button } from "@/components/ui/button";
import type {
  LocalCollaborationScope,
  LocalCollaborationScopeCatalog,
  PlanWeaveCollaborationApi
} from "../../shared/collaboration.js";
import type { createTranslator } from "../i18n";
import type { DesktopUiSettings } from "../types";
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

export function LocalCollaborationServerPanel({
  api,
  t,
  projectId,
  canvasId,
  scopeLayout,
  onScopeLayoutChange
}: {
  api: PlanWeaveCollaborationApi | null;
  t: ReturnType<typeof createTranslator>;
  projectId: string | null;
  canvasId: string | null;
  scopeLayout: DesktopUiSettings["layout"]["collaborationScope"];
  onScopeLayoutChange: (patch: Partial<DesktopUiSettings["layout"]["collaborationScope"]>) => void;
}) {
  const [status, setStatus] = useState<LoopbackServerStatus | null>(null);
  const [catalog, setCatalog] = useState<LocalCollaborationScopeCatalog | null>(null);
  const [draftScopes, setDraftScopes] = useState<LocalCollaborationScope[]>([]);
  const [scopes, setScopes] = useState<readonly LoopbackTrustedProjectScope[]>([]);
  const [registration, setRegistration] = useState<LoopbackProjectRegistrationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const [nextStatus, nextCatalog] = await Promise.all([
        api.getLocalCollaborationServerStatus(),
        api.getLocalCollaborationScopeCatalog()
      ]);
      setStatus(nextStatus);
      setCatalog(nextCatalog);
      setDraftScopes(selectedScopes(nextCatalog));
      setScopes(
        nextStatus.state === "running" ? await api.listLocalCollaborationTrustedScopes() : []
      );
      setError(null);
    } catch (caught) {
      setError(collaborationErrorMessage(caught));
    }
  }, [api]);

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

  const savedScopeKeys = useMemo(
    () => new Set(catalog ? selectedScopes(catalog).map(scopeKey) : []),
    [catalog]
  );
  const draftScopeKeys = useMemo(() => new Set(draftScopes.map(scopeKey)), [draftScopes]);
  const expandedProjectIds = useMemo(
    () => new Set(scopeLayout.expandedProjectIds),
    [scopeLayout.expandedProjectIds]
  );
  const scopeChanged =
    savedScopeKeys.size !== draftScopeKeys.size ||
    [...savedScopeKeys].some((key) => !draftScopeKeys.has(key));
  const currentCatalogCanvas = catalog?.projects
    .flatMap((project) => project.canvases)
    .find((canvas) => canvas.current);
  const currentScope = scopes.find(
    (scope) => scope.projectId === projectId && scope.canvasId === canvasId
  );

  if (!api) return null;
  const running = status?.state === "running";
  const statusLabel =
    status?.state === "error"
      ? status.reason === "stop_failed"
        ? t("localServerStopFailed")
        : status.reason === "unavailable"
          ? t("localServerUnavailable")
          : t("localServerStartFailed")
      : running
        ? t("localServerRunning")
        : t("localServerStopped");

  const toggleScope = (scope: LocalCollaborationScope) => {
    const key = scopeKey(scope);
    setDraftScopes((current) =>
      current.some((item) => scopeKey(item) === key)
        ? current.filter((item) => scopeKey(item) !== key)
        : [...current, scope]
    );
    setRegistration(null);
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

  const start = async () => {
    setBusy(true);
    try {
      await applyScopes();
      const nextStatus = await api.startLocalCollaborationServer();
      setStatus(nextStatus);
      setRegistration(null);
      await refresh();
    } catch (caught) {
      setError(collaborationErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const applyRunningScopes = async () => {
    setBusy(true);
    try {
      await applyScopes();
      setRegistration(null);
      await refresh();
    } catch (caught) {
      setError(collaborationErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      setStatus(await api.stopLocalCollaborationServer());
      setRegistration(null);
      await refresh();
    } catch (caught) {
      setError(collaborationErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const register = async () => {
    setBusy(true);
    try {
      const nextRegistration = await api.registerLocalCollaborationCurrentProject({
        ownerDisplayName: t("localServerDefaultOwnerName")
      });
      setRegistration(nextRegistration);
      await refresh();
    } catch (caught) {
      setError(collaborationErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="bg-background"
      data-testid="local-collaboration-server-panel"
      aria-labelledby="local-collaboration-server-title"
    >
      <div className="flex flex-col gap-5 px-1 pb-6 pt-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-4">
          <div className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-300">
            <LaptopIcon className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2
                id="local-collaboration-server-title"
                className="text-base font-semibold tracking-tight text-text-strong"
              >
                {t("localServerTitle")}
              </h2>
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  running
                    ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
                    : "bg-muted text-muted-foreground"
                }`}
                data-testid="local-collaboration-server-status"
              >
                <span
                  className={`size-1.5 rounded-full ${running ? "bg-emerald-500" : "bg-muted-foreground/50"}`}
                />
                {statusLabel}
              </span>
            </div>
            <p className="mt-1.5 max-w-2xl text-xs leading-5 text-muted-foreground">
              {t("localServerDescription")}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
          {running ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void stop()}
            >
              {t("localServerStop")}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={busy || draftScopes.length === 0}
              onClick={() => void start()}
            >
              {busy
                ? t("peopleWorking")
                : t("localServerStartSelected").replace("{count}", String(draftScopes.length))}
            </Button>
          )}
        </div>
      </div>

      <div className="border-y border-border/70 px-1 py-5">
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
                      className="divide-y divide-border/40 border-t border-border/50 bg-muted/10"
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

        {running && scopeChanged ? (
          <div className="mt-4 flex items-center justify-between gap-3 border-l-2 border-amber-500 bg-amber-500/5 px-3 py-2.5">
            <span className="text-[11px] text-amber-900 dark:text-amber-200">
              {t("localServerScopeChanged")}
            </span>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => void applyRunningScopes()}
            >
              {t("localServerApplyScopes")}
            </Button>
          </div>
        ) : null}

        {running && currentCatalogCanvas?.selected ? (
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border/50 pt-4">
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
            <Button type="button" size="sm" disabled={busy} onClick={() => void register()}>
              {busy ? t("peopleWorking") : t("localServerRegisterCurrent")}
            </Button>
          </div>
        ) : null}

        {registration ? (
          <div
            className="mt-2 flex items-center gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-300"
            role="status"
          >
            <CheckCircle2Icon className="size-3.5" aria-hidden="true" />
            {t("localServerRegistered")}: {registration.registeredAt}
          </div>
        ) : null}
      </div>

      {error ? (
        <div
          className="border-b border-destructive/30 bg-destructive/5 px-1 py-3 text-xs text-destructive"
          role="alert"
        >
          {error}
        </div>
      ) : null}
    </section>
  );
}
