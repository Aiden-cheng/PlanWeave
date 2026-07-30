import { useCallback, useEffect, useState } from "react";
import { CheckCircle2Icon, LaptopIcon } from "lucide-react";
import type {
  LoopbackProjectRegistrationView,
  LoopbackServerStatus,
  LoopbackTrustedProjectScope
} from "@planweave-ai/collaboration-contracts";
import { Button } from "@/components/ui/button";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import type { createTranslator } from "../i18n";
import { collaborationErrorMessage } from "./formatCollaborationError";

const ownerInitializationRequiredCode = "local_collaboration_owner_initialization_required";
const capabilityDeniedCode = "access_capability_denied";

function requiresOwnerInitialization(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes(ownerInitializationRequiredCode) || message.includes(capabilityDeniedCode)
  );
}

export function LocalCollaborationServerPanel({
  api,
  t,
  profileId,
  projectId,
  canvasId
}: {
  api: PlanWeaveCollaborationApi | null;
  t: ReturnType<typeof createTranslator>;
  profileId: string | null;
  projectId: string | null;
  canvasId: string | null;
}) {
  const [status, setStatus] = useState<LoopbackServerStatus | null>(null);
  const [scopes, setScopes] = useState<readonly LoopbackTrustedProjectScope[]>([]);
  const [registration, setRegistration] = useState<LoopbackProjectRegistrationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const nextStatus = await api.getLocalCollaborationServerStatus();
      setStatus(nextStatus);
      setScopes(
        nextStatus.state === "running" ? await api.listLocalCollaborationTrustedScopes() : []
      );
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!api) return null;
  const running = status?.state === "running";
  const currentScope = scopes.find(
    (scope) => scope.projectId === projectId && scope.canvasId === canvasId
  );
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
  const action = async () => {
    setBusy(true);
    try {
      setStatus(
        running
          ? await api.stopLocalCollaborationServer()
          : await api.startLocalCollaborationServer()
      );
      setRegistration(null);
      await refresh();
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  const register = async () => {
    setBusy(true);
    try {
      let nextRegistration: LoopbackProjectRegistrationView;
      try {
        nextRegistration = await api.registerLocalCollaborationCurrentProject();
      } catch (caught) {
        if (!requiresOwnerInitialization(caught)) throw caught;
        if (!profileId) throw new Error(ownerInitializationRequiredCode);
        await api.bootstrapCollaborationOwner({
          profileId,
          request: { displayName: t("localServerDefaultOwnerName") }
        });
        nextRegistration = await api.registerLocalCollaborationCurrentProject();
      }
      setRegistration(nextRegistration);
      await refresh();
      setError(null);
    } catch (caught) {
      setError(
        requiresOwnerInitialization(caught)
          ? t("localServerOwnerRequired")
          : collaborationErrorMessage(caught)
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="overflow-hidden rounded-xl border border-border/70 bg-background shadow-sm"
      data-testid="local-collaboration-server-panel"
      aria-labelledby="local-collaboration-server-title"
    >
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
            <LaptopIcon className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2
                id="local-collaboration-server-title"
                className="text-sm font-semibold text-text-strong"
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
            <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
              {t("localServerDescription")}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
          {running ? (
            <>
              <Button type="button" size="sm" disabled={busy} onClick={() => void register()}>
                {busy ? t("peopleWorking") : t("localServerRegisterCurrent")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void action()}
              >
                {t("localServerStop")}
              </Button>
            </>
          ) : (
            <Button type="button" size="sm" disabled={busy} onClick={() => void action()}>
              {busy ? t("peopleWorking") : t("localServerStart")}
            </Button>
          )}
        </div>
      </div>
      {running ? (
        <div className="border-t border-border/60 bg-muted/20 px-4 py-3">
          <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {t("localServerTrustedScope")}
          </div>
          <div className="mt-1 break-all font-mono text-[11px] text-text-strong">
            {currentScope
              ? `${currentScope.projectId} / ${currentScope.canvasId}`
              : t("localServerOwnerPending")}
          </div>
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
      ) : null}
      {error ? (
        <div
          className="border-t border-destructive/20 bg-destructive/5 px-4 py-2.5 text-xs text-destructive"
          role="alert"
        >
          {error}
        </div>
      ) : null}
    </section>
  );
}
