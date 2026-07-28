import { useCallback, useEffect, useMemo, useState } from "react";
import type { OperatorHostPage, OperatorHostView } from "@planweave-ai/distributed-protocol";
import {
  OperatorControlError,
  type OperatorHostBootstrapConfig,
  type OperatorHostBootstrapHandoffView,
  type OperatorControlProfile,
  type OperatorControlStatus,
  type OperatorProfileView
} from "../../shared/operatorControl";
import { operatorControlBridge } from "../bridge";

export type HostAdministrationLoadState = "loading" | "ready" | "unavailable";

export type HostAdministrationController = {
  status: OperatorControlStatus | null;
  hosts: OperatorHostView[];
  activeProfile: OperatorProfileView | null;
  loadState: HostAdministrationLoadState;
  hostsLoading: boolean;
  busy: boolean;
  error: string | null;
  handoff: OperatorHostBootstrapHandoffView | null;
  refresh: () => Promise<void>;
  refreshHosts: () => Promise<void>;
  saveProfile: (profile: OperatorControlProfile) => Promise<boolean>;
  removeProfile: (profileId: string) => Promise<boolean>;
  selectProfile: (profileId: string) => Promise<boolean>;
  clearActiveProfile: () => Promise<boolean>;
  importCredential: (profileId: string, operatorId?: string) => Promise<boolean>;
  clearCredential: (profileId: string) => Promise<boolean>;
  copyBootstrapHandoff: (
    bootstrap: OperatorHostBootstrapConfig
  ) => Promise<OperatorHostBootstrapHandoffView | null>;
  revokeHost: (hostId: string) => Promise<OperatorHostView | null>;
  dismissHandoff: () => void;
  clearError: () => void;
};

function errorMessage(error: unknown): string {
  const knownCodes = new Set([
    "operator_bridge_unavailable",
    "operator_credential_missing",
    "operator_profile_missing",
    "operator_profile_not_found",
    "operator_offline",
    "operator_timeout",
    "operator_unauthorized",
    "operator_credential_invalid",
    "operator_admin_required",
    "operator_forbidden"
  ]);
  if (error instanceof OperatorControlError && knownCodes.has(error.code)) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && knownCodes.has(code)) return code;
  }
  if (error instanceof Error && knownCodes.has(error.message)) return error.message;
  return "operator_request_failed";
}

function nextExpiry(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function useHostAdministrationController(): HostAdministrationController {
  const [status, setStatus] = useState<OperatorControlStatus | null>(null);
  const [hosts, setHosts] = useState<OperatorHostView[]>([]);
  const [loadState, setLoadState] = useState<HostAdministrationLoadState>("loading");
  const [hostsLoading, setHostsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<OperatorHostBootstrapHandoffView | null>(null);

  const refresh = useCallback(async () => {
    if (!operatorControlBridge) {
      setLoadState("unavailable");
      setError("operator_bridge_unavailable");
      return;
    }
    setLoadState("loading");
    try {
      setStatus(await operatorControlBridge.getOperatorControlStatus());
      setError(null);
      setLoadState("ready");
    } catch (cause) {
      setError(errorMessage(cause));
      setLoadState("ready");
    }
  }, []);

  const activeProfile = useMemo(
    () => status?.profiles.find((profile) => profile.profileId === status.activeProfileId) ?? null,
    [status]
  );

  const refreshHosts = useCallback(async () => {
    if (!operatorControlBridge || !activeProfile || !activeProfile.hasOperatorCredential) {
      setHosts([]);
      return;
    }
    setHostsLoading(true);
    try {
      const page: OperatorHostPage = await operatorControlBridge.listOperatorHosts({
        profileId: activeProfile.profileId,
        query: { cursor: 0, limit: 100 }
      });
      setHosts(page.items);
      setError(null);
    } catch (cause) {
      setHosts([]);
      setError(errorMessage(cause));
    } finally {
      setHostsLoading(false);
    }
  }, [activeProfile]);

  useEffect(() => {
    void refresh();
    if (!operatorControlBridge) return;
    return operatorControlBridge.onOperatorControlStatusChanged((next) => setStatus(next));
  }, [refresh]);

  useEffect(() => {
    void refreshHosts();
  }, [refreshHosts]);

  const runStatusAction = useCallback(
    async (action: () => Promise<OperatorControlStatus>): Promise<boolean> => {
      if (!operatorControlBridge) {
        setError("operator_bridge_unavailable");
        return false;
      }
      setBusy(true);
      try {
        setStatus(await action());
        setError(null);
        return true;
      } catch (cause) {
        setError(errorMessage(cause));
        return false;
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const saveProfile = useCallback(
    (profile: OperatorControlProfile) =>
      runStatusAction(() => operatorControlBridge!.upsertOperatorProfile(profile)),
    [runStatusAction]
  );

  const removeProfile = useCallback(
    (profileId: string) =>
      runStatusAction(() => operatorControlBridge!.removeOperatorProfile({ profileId })),
    [runStatusAction]
  );

  const selectProfile = useCallback(
    (profileId: string) =>
      runStatusAction(() => operatorControlBridge!.setActiveOperatorProfile({ profileId })),
    [runStatusAction]
  );

  const clearActiveProfile = useCallback(
    () => runStatusAction(() => operatorControlBridge!.clearActiveOperatorProfile()),
    [runStatusAction]
  );

  const importCredential = useCallback(
    (profileId: string, operatorId?: string) =>
      runStatusAction(() =>
        operatorControlBridge!.importOperatorCredential({
          profileId,
          ...(operatorId?.trim() ? { operatorId: operatorId.trim() } : {})
        })
      ),
    [runStatusAction]
  );

  const clearCredential = useCallback(
    (profileId: string) =>
      runStatusAction(() => operatorControlBridge!.clearOperatorCredential({ profileId })),
    [runStatusAction]
  );

  const copyBootstrapHandoff = useCallback(
    async (bootstrap: OperatorHostBootstrapConfig) => {
      if (!operatorControlBridge || !activeProfile || !activeProfile.hasOperatorCredential) {
        setError("operator_credential_missing");
        return null;
      }
      setBusy(true);
      try {
        const result = await operatorControlBridge.copyOperatorHostBootstrapHandoff({
          profileId: activeProfile.profileId,
          request: {
            expiresAt: nextExpiry(15),
            credentialExpiresAt: nextExpiry(24 * 60)
          },
          bootstrap
        });
        setHandoff(result);
        setError(null);
        return result;
      } catch (cause) {
        setError(errorMessage(cause));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [activeProfile]
  );

  const revokeHost = useCallback(
    async (hostId: string) => {
      if (!operatorControlBridge || !activeProfile) {
        setError("operator_profile_missing");
        return null;
      }
      setBusy(true);
      try {
        const revoked = await operatorControlBridge.revokeOperatorHost({
          profileId: activeProfile.profileId,
          hostId
        });
        setHosts((current) => current.map((host) => (host.id === hostId ? revoked : host)));
        setError(null);
        return revoked;
      } catch (cause) {
        setError(errorMessage(cause));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [activeProfile]
  );

  return {
    status,
    hosts,
    activeProfile,
    loadState,
    hostsLoading,
    busy,
    error,
    handoff,
    refresh,
    refreshHosts,
    saveProfile,
    removeProfile,
    selectProfile,
    clearActiveProfile,
    importCredential,
    clearCredential,
    copyBootstrapHandoff,
    revokeHost,
    dismissHandoff: () => setHandoff(null),
    clearError: () => setError(null)
  };
}
