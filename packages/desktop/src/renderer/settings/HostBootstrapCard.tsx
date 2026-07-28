import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  OperatorHostBootstrapConfig,
  OperatorHostBootstrapHandoffView,
  OperatorProfileView
} from "../../shared/operatorControl";
import type { createTranslator } from "../i18n";

type HostBootstrapCardProps = {
  activeProfile: OperatorProfileView | null;
  busy: boolean;
  copyBootstrapHandoff: (
    bootstrap: OperatorHostBootstrapConfig
  ) => Promise<OperatorHostBootstrapHandoffView | null>;
  dismissHandoff: () => void;
  handoff: OperatorHostBootstrapHandoffView | null;
  t: ReturnType<typeof createTranslator>;
};

function formatDate(value: string, locale: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(locale);
}

function isAbsolutePath(value: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/])/.test(value.trim());
}

export function HostBootstrapCard({
  activeProfile,
  busy,
  copyBootstrapHandoff,
  dismissHandoff,
  handoff,
  t,
  handoffState = "idle",
  handoffError = null,
  onRetry
}: HostBootstrapCardProps & {
  /** Honest Host bootstrap lifecycle for pending/error/retry UI. */
  handoffState?: "idle" | "pending" | "ready" | "failed" | "expired" | "revoked";
  handoffError?: string | null;
  onRetry?: (bootstrap: OperatorHostBootstrapConfig) => void;
}) {
  const locale = t("hostAdminLocale");
  const [configPath, setConfigPath] = useState("/etc/planweave/agent-host.json");
  const [dataDirectory, setDataDirectory] = useState("/var/lib/planweave-agent-host");
  const [workspaceRoot, setWorkspaceRoot] = useState("/var/lib/planweave-agent-host/workspaces");
  const [workspacePath, setWorkspacePath] = useState("project");
  const [hostDisplayName, setHostDisplayName] = useState(
    activeProfile?.displayName ?? "Agent Host"
  );
  const [capacity, setCapacity] = useState("1");
  const [capabilities, setCapabilities] = useState("linux.x64");
  const resolvedHandoffState =
    handoffState !== "idle"
      ? handoffState
      : busy
        ? "pending"
        : handoff
          ? "ready"
          : handoffError
            ? "failed"
            : "idle";

  useEffect(() => {
    if (activeProfile && !handoff) setHostDisplayName(activeProfile.displayName);
  }, [activeProfile, handoff]);

  const coordinatorIsSecure = useMemo(() => {
    if (!activeProfile) return false;
    const url = new URL(activeProfile.serverBaseUrl);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    return url.protocol === "https:" || (url.protocol === "http:" && loopback);
  }, [activeProfile]);

  const capabilityValues = useMemo(
    () =>
      capabilities
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    [capabilities]
  );
  const parsedCapacity = Number(capacity);
  const configValidationError =
    !activeProfile || !coordinatorIsSecure
      ? "hostAdminBootstrapSecureCoordinator"
      : !isAbsolutePath(configPath) ||
          !isAbsolutePath(dataDirectory) ||
          !isAbsolutePath(workspaceRoot)
        ? "hostAdminBootstrapAbsolutePaths"
        : !workspacePath.trim() ||
            workspacePath.includes("\\") ||
            workspacePath
              .split("/")
              .some((segment) => !segment || segment === "." || segment === "..")
          ? "hostAdminBootstrapWorkspacePath"
          : !hostDisplayName.trim()
            ? "hostAdminBootstrapHostName"
            : !Number.isInteger(parsedCapacity) || parsedCapacity < 1 || parsedCapacity > 128
              ? "hostAdminBootstrapCapacity"
              : capabilityValues.length === 0 ||
                  capabilityValues.some((value) => !/^[a-z0-9][a-z0-9._:-]*$/.test(value))
                ? "hostAdminBootstrapCapabilities"
                : null;

  const bootstrap = useMemo<OperatorHostBootstrapConfig | null>(() => {
    if (configValidationError) return null;
    return {
      configPath: configPath.trim(),
      dataDirectory: dataDirectory.trim(),
      workspaceRoot: workspaceRoot.trim(),
      workspacePath: workspacePath.trim(),
      acpProfilePreset: "codex-acp",
      host: {
        displayName: hostDisplayName.trim(),
        capacity: parsedCapacity,
        capabilities: capabilityValues
      }
    };
  }, [
    capabilityValues,
    configPath,
    configValidationError,
    dataDirectory,
    hostDisplayName,
    parsedCapacity,
    workspaceRoot,
    workspacePath
  ]);

  return (
    <Card data-testid="host-admin-bootstrap" data-handoff-state={resolvedHandoffState}>
      <CardHeader>
        <CardTitle>{t("hostAdminBootstrapTitle")}</CardTitle>
        <CardDescription>{t("hostAdminBootstrapDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-xs text-text-muted">{t("hostAdminBootstrapBoundary")}</p>
        <div
          className="rounded-md border border-border/70 bg-muted/20 px-2 py-1.5 text-xs"
          data-testid="host-admin-bootstrap-status"
          data-state={resolvedHandoffState}
          role="status"
        >
          {resolvedHandoffState === "pending"
            ? t("hostAdminBootstrapPending")
            : resolvedHandoffState === "ready"
              ? t("hostAdminBootstrapReady")
              : resolvedHandoffState === "failed"
                ? t("hostAdminBootstrapFailed")
                : resolvedHandoffState === "expired"
                  ? t("hostAdminBootstrapExpired")
                  : resolvedHandoffState === "revoked"
                    ? t("hostAdminBootstrapRevoked")
                    : t("hostAdminBootstrapIdle")}
          {handoffError ? (
            <div className="mt-1 text-destructive" data-testid="host-admin-bootstrap-error">
              {handoffError}
            </div>
          ) : null}
          {resolvedHandoffState === "failed" && onRetry ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-2"
              data-testid="host-admin-bootstrap-retry"
              disabled={busy}
              onClick={() => {
                if (bootstrap) onRetry(bootstrap);
              }}
            >
              {t("hostAdminBootstrapRetry")}
            </Button>
          ) : null}
        </div>
        <div className="grid gap-3 rounded-md border border-border/70 p-3">
          <div className="grid gap-1.5">
            <Label htmlFor="host-admin-config-path">{t("hostAdminConfigPath")}</Label>
            <Input
              id="host-admin-config-path"
              data-testid="host-admin-config-path"
              value={configPath}
              onChange={(event) => setConfigPath(event.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="host-admin-data-directory">{t("hostAdminDataDirectory")}</Label>
              <Input
                id="host-admin-data-directory"
                data-testid="host-admin-data-directory"
                value={dataDirectory}
                onChange={(event) => setDataDirectory(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="host-admin-workspace-root">{t("hostAdminWorkspaceRoot")}</Label>
              <Input
                id="host-admin-workspace-root"
                data-testid="host-admin-workspace-root"
                value={workspaceRoot}
                onChange={(event) => setWorkspaceRoot(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="host-admin-workspace-path">{t("hostAdminWorkspacePath")}</Label>
              <Input
                id="host-admin-workspace-path"
                data-testid="host-admin-workspace-path"
                value={workspacePath}
                onChange={(event) => setWorkspacePath(event.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="host-admin-host-name">{t("hostAdminHostDisplayName")}</Label>
              <Input
                id="host-admin-host-name"
                data-testid="host-admin-host-name"
                value={hostDisplayName}
                onChange={(event) => setHostDisplayName(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="host-admin-capacity">{t("hostAdminHostCapacity")}</Label>
              <Input
                id="host-admin-capacity"
                data-testid="host-admin-capacity"
                type="number"
                min={1}
                max={128}
                value={capacity}
                onChange={(event) => setCapacity(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="host-admin-capabilities">{t("hostAdminHostCapabilities")}</Label>
              <Input
                id="host-admin-capabilities"
                data-testid="host-admin-capabilities"
                value={capabilities}
                onChange={(event) => setCapabilities(event.target.value)}
                placeholder="linux.x64,codex"
              />
            </div>
          </div>
          <p className="text-xs text-text-muted">{t("hostAdminBootstrapCodexPreset")}</p>
          {configValidationError ? (
            <p
              className="text-xs text-destructive"
              role="alert"
              data-testid="host-admin-bootstrap-validation"
            >
              {t(configValidationError)}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          className="w-fit"
          data-testid="host-admin-create-grant"
          disabled={busy || !activeProfile?.hasOperatorCredential || !bootstrap}
          onClick={() => {
            if (bootstrap) void copyBootstrapHandoff(bootstrap);
          }}
        >
          {t("hostAdminCreateGrant")}
        </Button>
        {handoff ? (
          <div
            className="grid gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3"
            data-testid="host-admin-grant-once"
            role="alertdialog"
            aria-labelledby="host-admin-grant-title"
          >
            <div id="host-admin-grant-title" className="font-medium text-text-strong">
              {t("hostAdminGrantOnceTitle")}
            </div>
            <p className="text-xs text-text-muted">
              {t("hostAdminGrantOnceWarning").replace(
                "{expiry}",
                formatDate(handoff.expiresAt, locale)
              )}
            </p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="w-fit"
              data-testid="host-admin-close-grant"
              onClick={dismissHandoff}
            >
              {t("hostAdminCloseGrant")}
            </Button>
            <p className="text-xs text-text-muted">{t("hostAdminBootstrapHeartbeatNote")}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
