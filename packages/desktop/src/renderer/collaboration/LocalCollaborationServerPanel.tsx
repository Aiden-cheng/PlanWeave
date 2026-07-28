import { useCallback, useEffect, useState } from "react";
import type {
  LoopbackProjectRegistrationView,
  LoopbackServerStatus,
  LoopbackTrustedProjectScope
} from "@planweave-ai/collaboration-contracts";
import { Button } from "@/components/ui/button";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import type { createTranslator } from "../i18n";

export function LocalCollaborationServerPanel({
  api,
  t
}: {
  api: PlanWeaveCollaborationApi | null;
  t: ReturnType<typeof createTranslator>;
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
      setScopes(nextStatus.state === "running" ? await api.listLocalCollaborationTrustedScopes() : []);
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
      setStatus(running ? await api.stopLocalCollaborationServer() : await api.startLocalCollaborationServer());
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
      setRegistration(await api.registerLocalCollaborationCurrentProject());
      await refresh();
      setError(null);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message === "local_collaboration_owner_initialization_required" ? t("localServerOwnerRequired") : message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="flex flex-col gap-2" data-testid="local-collaboration-server-panel">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-text-strong">{t("localServerTitle")}</div>
          <div className="text-[11px] text-muted-foreground">
            {statusLabel}
          </div>
        </div>
        <Button type="button" size="sm" className="h-7 text-[10px]" disabled={busy} onClick={() => void action()}>
          {running ? t("localServerStop") : t("localServerStart")}
        </Button>
      </div>
      {running ? (
        <>
          <div className="text-[11px] text-muted-foreground">
            {scopes.length > 0
              ? `${t("localServerTrustedScope")}: ${scopes[0].projectId} / ${scopes[0].canvasId}`
              : t("localServerOwnerPending")}
          </div>
          <Button type="button" size="sm" variant="outline" className="h-7 w-fit text-[10px]" disabled={busy} onClick={() => void register()}>
            {t("localServerRegisterCurrent")}
          </Button>
          {registration ? <div className="text-[11px] text-muted-foreground">{t("localServerRegistered")}: {registration.registeredAt}</div> : null}
        </>
      ) : null}
      {error ? <div className="text-xs text-destructive" role="alert">{error}</div> : null}
    </section>
  );
}
