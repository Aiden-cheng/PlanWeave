import { useEffect, useMemo, useState } from "react";
import type {
  ConnectivityValidationView,
  DeploymentConnectionProfile,
  DeploymentGuidanceView,
  DeploymentTopology
} from "@planweave-ai/collaboration-contracts";
import type { OperatorHostView } from "@planweave-ai/distributed-protocol";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { collaborationBridge } from "../bridge";
import type { createTranslator } from "../i18n";

type Props = { hosts: OperatorHostView[]; t: ReturnType<typeof createTranslator> };

function initialTopology(origin: string): DeploymentTopology {
  const url = new URL(origin);
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  return loopback && url.protocol === "http:" ? "loopback_http" : "public_https";
}

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

export function DeploymentConnectionCard({ hosts, t }: Props) {
  const [origin, setOrigin] = useState("");
  const [topology, setTopology] = useState<DeploymentTopology>("loopback_http");
  const [profile, setProfile] = useState<DeploymentConnectionProfile | null>(null);
  const [guidance, setGuidance] = useState<DeploymentGuidanceView | null>(null);
  const [connectivity, setConnectivity] = useState<ConnectivityValidationView | null>(null);
  const [busy, setBusy] = useState<"guidance" | "validation" | "copy" | null>(null);
  const [notice, setNotice] = useState<"copied" | "invalid" | null>(null);

  useEffect(() => {
    if (!collaborationBridge) return;
    void collaborationBridge.getActiveWorkspaceConnection().then((connection) => {
      if (!connection.profile || !connection.workspaceId) return;
      setOrigin(connection.profile.serverBaseUrl);
      setTopology(initialTopology(connection.profile.serverBaseUrl));
      setProfile({
        schemaVersion: "deployment-connection/v1",
        profileId: connection.profile.profileId,
        displayName: connection.profile.displayName,
        workspace: { workspaceId: connection.workspaceId },
        endpoint: {
          topology: initialTopology(connection.profile.serverBaseUrl),
          serverOrigin: connection.profile.serverBaseUrl,
          allowedClientOrigins: [connection.profile.serverBaseUrl],
          tlsTrust:
            initialTopology(connection.profile.serverBaseUrl) === "loopback_http"
              ? "not_applicable"
              : "system_ca"
        },
        capabilities: ["workspace_connection", "deployment_guidance", "connectivity_validation"]
      });
    });
  }, []);

  const nextProfile = useMemo(() => {
    if (!profile) return null;
    try {
      const serverOrigin = normalizedOrigin(origin);
      return {
        ...profile,
        endpoint: {
          topology,
          serverOrigin,
          allowedClientOrigins: [serverOrigin],
          tlsTrust: topology === "loopback_http" ? "not_applicable" : "system_ca"
        }
      } satisfies DeploymentConnectionProfile;
    } catch {
      return null;
    }
  }, [origin, profile, topology]);

  const actionScope = () =>
    nextProfile ? { workspace: nextProfile.workspace, profile: nextProfile } : null;

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

  return (
    <Card data-testid="deployment-connection">
      <CardHeader>
        <CardTitle>{t("deploymentTitle")}</CardTitle>
        <CardDescription>{t("deploymentDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-xs text-text-muted">{t("deploymentBoundary")}</p>
        {!profile ? (
          <p className="text-xs text-text-muted">{t("deploymentWorkspaceRequired")}</p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="deployment-topology">{t("deploymentTopology")}</Label>
            <select
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              data-testid="deployment-topology"
              id="deployment-topology"
              value={topology}
              onChange={(event) => setTopology(event.target.value as DeploymentTopology)}
            >
              <option value="loopback_http">{t("deploymentLoopback")}</option>
              <option value="lan_https">{t("deploymentLan")}</option>
              <option value="public_https">{t("deploymentPublic")}</option>
            </select>
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
        </div>
        {topology === "loopback_http" ? (
          <p className="text-xs text-text-muted">{t("deploymentLoopbackNote")}</p>
        ) : null}
        {topology !== "loopback_http" ? (
          <p className="text-xs text-text-muted">{t("deploymentTopologySource")}</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={!nextProfile || busy !== null}
            onClick={() => void requestGuidance()}
          >
            {t("deploymentReview")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!nextProfile || busy !== null}
            onClick={() => void validate()}
          >
            {t("deploymentValidate")}
          </Button>
        </div>
        {guidance ? (
          <div
            className="grid gap-1 rounded-md border p-3 text-xs"
            data-testid="deployment-guidance"
          >
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
        {notice === "invalid" ? (
          <p className="text-xs text-destructive" role="alert">
            {t("deploymentInvalid")}
          </p>
        ) : null}
        <p className="text-xs text-text-muted">{t("deploymentHostBoundary")}</p>
        <div
          className="grid gap-2 rounded-md border p-3 text-xs"
          data-testid="deployment-host-availability"
        >
          <div className="font-medium text-text-strong">{t("deploymentHostReadiness")}</div>
          {hosts.length === 0 ? <p>{t("deploymentHostNone")}</p> : null}
          {hosts.map((host) => (
            <div key={host.id} className="rounded border border-border/70 p-2">
              <div>{host.displayName}</div>
              <div>{host.online ? t("deploymentHostOnline") : t("deploymentHostOffline")}</div>
              <div>
                {t("deploymentHostCapacity")}: {host.capacity}
              </div>
              <div>
                {t("deploymentHostCapabilities")}:{" "}
                {host.capabilities.join(", ") || t("deploymentHostCapabilitiesNone")}
              </div>
              <div className="text-destructive">{t("deploymentHostUnavailable")}</div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
