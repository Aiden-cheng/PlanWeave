import { useEffect, useMemo, useState } from "react";
import type {
  ConnectivityValidationView,
  DeploymentGuidanceView,
  DeploymentTargetDraft,
  DeploymentTopology
} from "@planweave-ai/collaboration-protocol/deployment";
import type {
  DesktopServerExposureErrorCode,
  DesktopServerExposureMode,
  DesktopServerExposureView
} from "../../shared/deploymentExposure";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { collaborationBridge } from "../bridge";
import type { createTranslator } from "../i18n";

type Props = {
  t: ReturnType<typeof createTranslator>;
  presentation?: "card" | "section" | "plain";
  onExposureChange?: (exposure: DesktopServerExposureView) => void;
};

function normalizedOrigin(value: string): string {
  return `${new URL(value.trim()).origin}/`;
}

function connectivityLabel(
  view: ConnectivityValidationView,
  t: ReturnType<typeof createTranslator>
): string {
  if (view.status === "reachable") return t("deploymentConnectivityReachable");
  if (view.status === "invalid_tls") return t("deploymentConnectivityTls");
  if (view.status === "invalid_origin") return t("deploymentConnectivityOrigin");
  if (view.status === "invalid_configuration") return t("deploymentConnectivityConfiguration");
  return t("deploymentConnectivityUnreachable");
}

function exposureErrorLabel(
  code: DesktopServerExposureErrorCode,
  t: ReturnType<typeof createTranslator>
): string {
  if (code === "PRIVATE_HTTPS_PROVIDER_NOT_INSTALLED") {
    return t("deploymentPrivateHttpsProviderNotInstalled");
  }
  if (code === "PRIVATE_HTTPS_PROVIDER_AUTH_REQUIRED") {
    return t("deploymentPrivateHttpsProviderAuthRequired");
  }
  if (
    code === "PRIVATE_HTTPS_DNS_UNAVAILABLE" ||
    code === "PRIVATE_HTTPS_CERTIFICATE_UNAVAILABLE"
  ) {
    return t("deploymentPrivateHttpsUnavailable");
  }
  if (code === "PRIVATE_HTTPS_ROUTE_CONFLICT") {
    return t("deploymentPrivateHttpsRouteConflict");
  }
  if (code.startsWith("PRIVATE_HTTPS_")) {
    return t("deploymentPrivateHttpsProviderUnavailable");
  }
  return t("deploymentServerStartFailed");
}

export function DeploymentConnectionCard({ t, presentation = "card", onExposureChange }: Props) {
  const [origin, setOrigin] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [mode, setMode] = useState<DesktopServerExposureMode>("local_only");
  const [customTopology, setCustomTopology] =
    useState<Extract<DeploymentTopology, "loopback_https" | "private_https" | "public_https">>(
      "public_https"
    );
  const [exposure, setExposure] = useState<DesktopServerExposureView | null>(null);
  const [guidance, setGuidance] = useState<DeploymentGuidanceView | null>(null);
  const [connectivity, setConnectivity] = useState<ConnectivityValidationView | null>(null);
  const [busy, setBusy] = useState<
    "activation" | "guidance" | "validation" | "copy" | "export" | null
  >(null);
  const [notice, setNotice] = useState<"copied" | "exported" | "invalid" | null>(null);

  useEffect(() => {
    if (!collaborationBridge) return;
    void Promise.all([
      collaborationBridge.getActiveWorkspaceConnection(),
      collaborationBridge.getDesktopServerExposure()
    ]).then(([connection, nextExposure]) => {
      setExposure(nextExposure);
      onExposureChange?.(nextExposure);
      setMode(nextExposure.mode);
      if (!connection.profile || !connection.workspaceId) return;
      setOrigin(connection.profile.serverBaseUrl);
      setDisplayName(connection.profile.displayName);
    });
  }, [onExposureChange]);

  const target = useMemo(() => {
    try {
      const trimmedDisplayName = displayName.trim();
      if (mode !== "custom_https" || !trimmedDisplayName) return null;
      const serverOrigin = normalizedOrigin(origin);
      return {
        schemaVersion: "deployment-target-draft/v1",
        displayName: trimmedDisplayName,
        endpoint: {
          topology: customTopology,
          serverOrigin,
          allowedClientOrigins: [serverOrigin],
          tlsTrust: "system_ca"
        },
        capabilities: ["deployment_guidance", "connectivity_validation"]
      } satisfies DeploymentTargetDraft;
    } catch {
      return null;
    }
  }, [customTopology, displayName, mode, origin]);

  const activate = async () => {
    if (!collaborationBridge || mode === "custom_https") return;
    setBusy("activation");
    try {
      const next = await collaborationBridge.setDesktopServerExposureMode({ mode });
      setExposure(next);
      onExposureChange?.(next);
      setNotice(next.lifecycle === "error" ? "invalid" : null);
    } catch {
      setNotice("invalid");
    } finally {
      setBusy(null);
    }
  };

  const actionScope = () => (target ? { target } : null);

  const requestGuidance = async () => {
    const scope = actionScope();
    const input = scope ? { action: "request_deployment_guidance" as const, ...scope } : null;
    if (!collaborationBridge || !input) return setNotice("invalid");
    setBusy("guidance");
    try {
      setGuidance(await collaborationBridge.getDeploymentGuidance(input));
      setNotice(null);
    } catch {
      setNotice("invalid");
    } finally {
      setBusy(null);
    }
  };

  const validate = async () => {
    const scope = actionScope();
    const input = scope ? { action: "validate_connectivity" as const, ...scope } : null;
    if (!collaborationBridge || !input) return setNotice("invalid");
    setBusy("validation");
    try {
      setConnectivity(await collaborationBridge.validateDeploymentConnectivity(input));
      setNotice(null);
    } catch {
      setNotice("invalid");
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    const scope = actionScope();
    const input = scope ? { action: "copy_supported_compose_handoff" as const, ...scope } : null;
    if (!collaborationBridge || !input) return setNotice("invalid");
    setBusy("copy");
    try {
      await collaborationBridge.copyDeploymentComposeHandoff(input);
      setNotice("copied");
    } catch {
      setNotice("invalid");
    } finally {
      setBusy(null);
    }
  };

  const exportBundle = async () => {
    const scope = actionScope();
    const input = scope ? { action: "export_supported_compose_bundle" as const, ...scope } : null;
    if (!collaborationBridge || !input) return setNotice("invalid");
    setBusy("export");
    try {
      const result = await collaborationBridge.exportDeploymentComposeBundle(input);
      setNotice(result.state === "exported" ? "exported" : "invalid");
    } catch {
      setNotice("invalid");
    } finally {
      setBusy(null);
    }
  };

  const content = (
    <div className="grid max-w-3xl gap-3">
      <p className="text-xs text-text-muted">{t("deploymentBoundary")}</p>
      <p className="text-xs text-text-muted">{t("deploymentPreConnection")}</p>
      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="deployment-topology">{t("deploymentTopology")}</Label>
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            data-testid="deployment-topology"
            id="deployment-topology"
            value={mode}
            onChange={(event) => setMode(event.target.value as DesktopServerExposureMode)}
          >
            <option value="local_only">{t("deploymentLoopback")}</option>
            <option value="private_https">{t("deploymentPrivateHttps")}</option>
            <option value="custom_https">{t("deploymentCustomHttps")}</option>
            <option value="lan_http">{t("deploymentLanAdvanced")}</option>
          </select>
        </div>
        {mode === "custom_https" ? (
          <>
            <div className="grid gap-1.5">
              <Label htmlFor="deployment-display-name">{t("deploymentDisplayName")}</Label>
              <Input
                id="deployment-display-name"
                data-testid="deployment-display-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="deployment-origin">{t("deploymentOrigin")}</Label>
              <Input
                id="deployment-origin"
                data-testid="deployment-origin"
                value={origin}
                onChange={(event) => setOrigin(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="deployment-custom-topology">{t("deploymentCustomTopology")}</Label>
              <select
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                data-testid="deployment-custom-topology"
                id="deployment-custom-topology"
                value={customTopology}
                onChange={(event) => setCustomTopology(event.target.value as typeof customTopology)}
              >
                <option value="loopback_https">{t("deploymentLoopbackHttps")}</option>
                <option value="private_https">{t("deploymentPrivateHttpsTopology")}</option>
                <option value="public_https">{t("deploymentPublicHttps")}</option>
              </select>
            </div>
          </>
        ) : null}
      </div>
      {mode === "local_only" ? (
        <p className="text-xs text-text-muted">{t("deploymentLoopbackNote")}</p>
      ) : null}
      {mode === "private_https" ? (
        <p className="text-xs text-text-muted" data-testid="deployment-private-https-note">
          {t("deploymentPrivateHttpsNote")}
        </p>
      ) : null}
      {mode === "lan_http" ? (
        <p className="text-xs text-destructive">{t("deploymentLanAdvancedNote")}</p>
      ) : null}
      {mode === "custom_https" ? (
        <div className="grid gap-1 text-xs text-text-muted">
          <p>{t("deploymentSystemTrustNote")}</p>
          <p>{t("deploymentTopologySource")}</p>
        </div>
      ) : null}
      {mode !== "custom_https" ? (
        <Button
          type="button"
          size="sm"
          className="w-fit"
          disabled={busy !== null || exposure?.canActivate === false}
          onClick={() => void activate()}
        >
          {t("deploymentActivate")}
        </Button>
      ) : null}
      {exposure?.advertisedOrigin ? (
        <p className="text-xs" data-testid="deployment-advertised-origin">
          {t("deploymentAdvertisedOrigin")}: {exposure.advertisedOrigin}
        </p>
      ) : null}
      {exposure?.provider ? (
        <p className="text-xs text-text-muted" data-testid="deployment-exposure-provider">
          {t("deploymentPrivateHttpsProvider")}: {exposure.provider.displayName}
        </p>
      ) : null}
      {exposure?.errorCode ? (
        <p
          className="text-xs text-destructive"
          data-testid="deployment-exposure-error"
          data-error-code={exposure.errorCode}
        >
          {exposureErrorLabel(exposure.errorCode, t)}
        </p>
      ) : null}
      {mode === "custom_https" ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={!target || busy !== null}
            onClick={() => void requestGuidance()}
          >
            {t("deploymentReview")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!target || busy !== null}
            onClick={() => void validate()}
          >
            {t("deploymentValidate")}
          </Button>
        </div>
      ) : null}
      {guidance ? (
        <div className="grid gap-1 rounded-md border p-3 text-xs" data-testid="deployment-guidance">
          <div>{t("deploymentDurableState")}</div>
          <div>{t("deploymentHealthcheck")}</div>
          {guidance.handoff.state === "supported" ? (
            <>
              <code className="break-all">{guidance.handoff.preview}</code>
              <p>
                {t("deploymentMount")}: {guidance.handoff.projectsMountTarget}
              </p>
              <p>
                {t("deploymentTrustedPath")}: {guidance.handoff.trustedProjectRootPattern}
              </p>
              <Button
                type="button"
                size="sm"
                className="w-fit"
                disabled={busy !== null}
                onClick={() => void copy()}
              >
                {t("deploymentCopy")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-fit"
                disabled={busy !== null}
                onClick={() => void exportBundle()}
              >
                {t("deploymentExport")}
              </Button>
              <p className="text-text-muted">{t("deploymentExportInstructions")}</p>
            </>
          ) : (
            <p>{t("deploymentLoopbackNote")}</p>
          )}
        </div>
      ) : null}
      {connectivity ? (
        <p className="text-xs" data-testid="deployment-connectivity">
          {t("deploymentConnectivity")}: {connectivityLabel(connectivity, t)}
        </p>
      ) : null}
      {notice === "copied" ? (
        <p className="text-xs" role="status">
          {t("deploymentCopied")}
        </p>
      ) : null}
      {notice === "exported" ? <p className="text-xs">{t("deploymentExported")}</p> : null}
      {notice === "invalid" ? (
        <p className="text-xs text-destructive" role="alert">
          {t("deploymentInvalid")}
        </p>
      ) : null}
    </div>
  );

  if (presentation === "section") {
    return (
      <section className="mt-7 border-t border-border/70 py-8" data-testid="deployment-connection">
        <div className="mb-5 max-w-3xl">
          <h2 className="text-lg font-semibold tracking-[-0.01em] text-text-strong">
            {t("deploymentTitle")}
          </h2>
          <p className="mt-1 text-sm leading-6 text-text-muted">{t("deploymentDescription")}</p>
        </div>
        {content}
      </section>
    );
  }

  if (presentation === "plain") {
    return (
      <section className="pb-8" data-testid="deployment-connection">
        <div className="mb-5 max-w-3xl">
          <h2 className="text-lg font-semibold tracking-[-0.01em] text-text-strong">
            {t("deploymentTitle")}
          </h2>
          <p className="mt-1 text-sm leading-6 text-text-muted">{t("deploymentDescription")}</p>
        </div>
        {content}
      </section>
    );
  }

  return (
    <Card data-testid="deployment-connection">
      <CardHeader>
        <CardTitle>{t("deploymentTitle")}</CardTitle>
        <CardDescription>{t("deploymentDescription")}</CardDescription>
      </CardHeader>
      <CardContent>{content}</CardContent>
    </Card>
  );
}
