import { useCallback, useEffect, useState } from "react";
import type { ContentVersionDesktopReadModel } from "@planweave-ai/collaboration-contracts";
import { Button } from "@/components/ui/button";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import type { createTranslator } from "../i18n";
import { collaborationErrorMessage } from "./formatCollaborationError";

export function ContentAuthorityPanel({
  api,
  canvasId,
  connected,
  t
}: {
  api: PlanWeaveCollaborationApi | null;
  canvasId: string | null;
  connected: boolean;
  t: ReturnType<typeof createTranslator>;
}) {
  const [model, setModel] = useState<ContentVersionDesktopReadModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (action: () => Promise<ContentVersionDesktopReadModel>) => {
    setBusy(true);
    setError(null);
    try {
      setModel(await action());
    } catch (cause) {
      setError(collaborationErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!api || !canvasId || !connected) {
      setModel(null);
      return;
    }
    void run(() => api.bindCollaborationContentAuthority({ canvasId }));
  }, [api, canvasId, connected, run]);

  if (!canvasId) return null;
  const revision = model?.authoritativeHead?.revision ?? t("contentAuthorityWaiting");
  return (
    <section className="mt-4 rounded-md border border-border p-3" data-testid="content-authority-panel">
      <h2 className="text-sm font-semibold">{t("contentAuthorityTitle")}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{t("contentAuthorityRevision").replace("{revision}", String(revision))}</p>
      <p className="text-xs text-muted-foreground">
        {t("contentAuthorityStatus").replace("{status}", model?.replicaStatus ?? t("contentAuthorityOffline"))}
      </p>
      {model?.lastAcknowledgement ? <p className="text-xs text-muted-foreground">{t("contentAuthorityAcknowledged")}</p> : null}
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={!api || !connected || busy} onClick={() => api && run(() => api.refreshCollaborationContentAuthority())}>{t("contentAuthorityRetry")}</Button>
        {model?.canPublishInitial ? <Button size="sm" disabled={busy} onClick={() => api && run(() => api.publishCollaborationInitialContent())}>{t("contentAuthorityPublish")}</Button> : null}
        {model?.canMaterialize ? <Button size="sm" disabled={busy} onClick={() => api && run(() => api.materializeCollaborationContentHead())}>{model.canRecover ? t("contentAuthorityRecover") : t("contentAuthorityMaterialize")}</Button> : null}
      </div>
    </section>
  );
}
