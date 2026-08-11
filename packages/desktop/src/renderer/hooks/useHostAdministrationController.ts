import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_HOST_CREDENTIAL_LIFETIME_DAYS,
  type HostCredentialLifetimeDays
} from "@planweave-ai/agent-host-protocol/browser";
import type {
  OperatorHostPage,
  OperatorHostView
} from "@planweave-ai/agent-host-protocol/operator-control";
import {
  OperatorControlError,
  type OperatorHostBootstrapHandoffView,
  type OperatorMemberSetupCodeHandoffView,
  type OperatorControlProfileInput,
  type OperatorControlStatus,
  type OperatorLocalAgentHostStatus,
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
  memberSetupCodeHandoff: OperatorMemberSetupCodeHandoffView | null;
  localAgentHost: OperatorLocalAgentHostStatus | null;
  localAgentHostLoading: boolean;
  credentialLifetimeDays: HostCredentialLifetimeDays;
  refresh: () => Promise<void>;
  refreshHosts: () => Promise<void>;
  saveProfile: (profile: OperatorControlProfileInput) => Promise<boolean>;
  removeProfile: (profileId: string) => Promise<boolean>;
  selectProfile: (profileId: string) => Promise<boolean>;
  clearActiveProfile: () => Promise<boolean>;
  importCredential: (profileId: string, operatorId?: string) => Promise<boolean>;
  clearCredential: (profileId: string) => Promise<boolean>;
  copyBootstrapHandoff: () => Promise<OperatorHostBootstrapHandoffView | null>;
  copyMemberSetupCode: () => Promise<OperatorMemberSetupCodeHandoffView | null>;
  revokeHost: (hostId: string) => Promise<OperatorHostView | null>;
  renewHostCredential: (hostId: string) => Promise<OperatorHostView | null>;
  setCredentialLifetimeDays: (days: HostCredentialLifetimeDays) => void;
  registerLocalAgentHost: (
    exposedProfileIds: readonly string[]
  ) => Promise<OperatorLocalAgentHostStatus | null>;
  repairLocalAgentHost: (
    exposedProfileIds: readonly string[]
  ) => Promise<OperatorLocalAgentHostStatus | null>;
  enrollLocalAgentHost: (
    handoff: string,
    exposedProfileIds: readonly string[]
  ) => Promise<OperatorLocalAgentHostStatus | null>;
  dismissHandoff: () => void;
  dismissMemberSetupCodeHandoff: () => void;
  clearError: () => void;
};

const knownErrorCodes = new Set([
  "operator_bridge_unavailable",
  "operator_credential_missing",
  "operator_profile_missing",
  "operator_profile_not_found",
  "operator_offline",
  "operator_timeout",
  "operator_unauthorized",
  "operator_credential_invalid",
  "operator_admin_required",
  "operator_server_admin_required",
  "operator_forbidden",
  "local_agent_host_unavailable",
  "local_agent_host_custom_ca_unsupported",
  "local_agent_host_handoff_invalid",
  "local_agent_host_handoff_expired",
  "agent_host_enrollment_rejected",
  "agent_host_enrollment_exchange_failed",
  "agent_host_enrollment_transport_insecure",
  "agent_host_enrollment_transport_unsupported",
  "agent_host_enrollment_response_malformed",
  "agent_host_enrollment_response_too_large",
  "agent_host_enrollment_response_mismatch",
  "agent_host_enrollment_response_expired",
  "agent_host_enrollment_already_pending",
  "agent_host_handoff_config_conflict",
  "agent_host_handoff_pending_conflict",
  "agent_host_handoff_credential_conflict",
  "agent_host_handoff_provenance_invalid",
  "agent_host_windows_user_sid_unavailable",
  "agent_host_preset_binary_missing",
  "agent_host_background_setup_required"
]);

function knownErrorCode(value: string): string | null {
  for (const code of knownErrorCodes) {
    if (value === code || value.includes(`: ${code}`)) return code;
  }
  return null;
}

function safeAgentHostErrorCode(value: string): string | null {
  return value.match(/(?:agent_host|local_agent_host)_[a-z0-9_]+/)?.[0] ?? null;
}

function errorMessage(error: unknown): string {
  if (error instanceof OperatorControlError && knownErrorCodes.has(error.code)) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && knownErrorCodes.has(code)) return code;
  }
  if (error instanceof Error) {
    return (
      knownErrorCode(error.message) ??
      safeAgentHostErrorCode(error.message) ??
      "operator_request_failed"
    );
  }
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
  const [memberSetupCodeHandoff, setMemberSetupCodeHandoff] =
    useState<OperatorMemberSetupCodeHandoffView | null>(null);
  const [localAgentHost, setLocalAgentHost] = useState<OperatorLocalAgentHostStatus | null>(null);
  const [localAgentHostLoading, setLocalAgentHostLoading] = useState(false);
  const [credentialLifetimeDays, setCredentialLifetimeDays] = useState<HostCredentialLifetimeDays>(
    DEFAULT_HOST_CREDENTIAL_LIFETIME_DAYS
  );

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
  const activeProfileId = activeProfile?.profileId;
  const activeProfileHasOperatorCredential = activeProfile?.hasOperatorCredential === true;
  const previousActiveProfileId = useRef(activeProfile?.profileId);
  const activeProfileIdRef = useRef(activeProfileId);
  activeProfileIdRef.current = activeProfileId;
  const hostRefreshInFlight = useRef<{
    profileId: string;
    promise: Promise<void>;
  } | null>(null);

  useEffect(() => {
    const activeProfileId = activeProfile?.profileId;
    if (previousActiveProfileId.current !== activeProfileId) {
      previousActiveProfileId.current = activeProfileId;
      setMemberSetupCodeHandoff(null);
    }
  }, [activeProfile?.profileId]);

  const refreshHosts = useCallback(
    (options?: { silent?: boolean }): Promise<void> => {
      if (!operatorControlBridge || !activeProfileId || !activeProfileHasOperatorCredential) {
        setHosts([]);
        return Promise.resolve();
      }
      if (hostRefreshInFlight.current?.profileId === activeProfileId) {
        return hostRefreshInFlight.current.promise;
      }
      if (!options?.silent) setHostsLoading(true);
      const profileId = activeProfileId;
      const promise = operatorControlBridge
        .listOperatorHosts({ profileId, query: { cursor: 0, limit: 100 } })
        .then((page: OperatorHostPage) => {
          if (activeProfileIdRef.current !== profileId) return;
          setHosts(page.items);
          setError(null);
        })
        .catch((cause) => {
          if (activeProfileIdRef.current !== profileId) return;
          if (!options?.silent) setHosts([]);
          setError(errorMessage(cause));
        })
        .finally(() => {
          if (hostRefreshInFlight.current?.promise === promise) {
            hostRefreshInFlight.current = null;
          }
          if (!options?.silent && activeProfileIdRef.current === profileId) {
            setHostsLoading(false);
          }
        });
      hostRefreshInFlight.current = { profileId, promise };
      return promise;
    },
    [activeProfileId, activeProfileHasOperatorCredential]
  );

  useEffect(() => {
    void refresh();
    if (!operatorControlBridge) return;
    return operatorControlBridge.onOperatorControlStatusChanged((next) => setStatus(next));
  }, [refresh]);

  useEffect(() => {
    void refreshHosts();
  }, [refreshHosts]);

  useEffect(() => {
    if (!activeProfileId || !activeProfileHasOperatorCredential) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refreshHosts({ silent: true });
      if (!cancelled) timer = setTimeout(() => void poll(), 5_000);
    };
    timer = setTimeout(() => void poll(), 5_000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeProfileHasOperatorCredential, activeProfileId, refreshHosts]);

  useEffect(() => {
    if (!operatorControlBridge) {
      setLocalAgentHost(null);
      return;
    }
    let active = true;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    const loadLocalAgentHost = (options?: { silent?: boolean }) => {
      if (!options?.silent) setLocalAgentHostLoading(true);
      return operatorControlBridge!
        .getOperatorLocalAgentHostStatus(activeProfileId ? { profileId: activeProfileId } : {})
        .then((next) => {
          if (active) setLocalAgentHost(next);
        })
        .catch((cause) => {
          if (active && !options?.silent) setError(errorMessage(cause));
        })
        .finally(() => {
          if (active && !options?.silent) setLocalAgentHostLoading(false);
        });
    };

    void loadLocalAgentHost();
    // Refresh connection-status.json while Host is registered so process vs Server state stays current.
    pollTimer = setInterval(() => {
      void loadLocalAgentHost({ silent: true });
    }, 5_000);

    return () => {
      active = false;
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [activeProfileId]);

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
    (profile: OperatorControlProfileInput) =>
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

  const copyBootstrapHandoff = useCallback(async () => {
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
          credentialPolicy: { lifetimeDays: credentialLifetimeDays, renewal: "automatic" }
        }
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
  }, [activeProfile, credentialLifetimeDays]);

  const copyMemberSetupCode = useCallback(async () => {
    if (!operatorControlBridge || !activeProfile || !activeProfile.hasOperatorCredential) {
      setError("operator_credential_missing");
      return null;
    }
    setBusy(true);
    try {
      const result = await operatorControlBridge.copyOperatorMemberSetupCode({
        profileId: activeProfile.profileId
      });
      setMemberSetupCodeHandoff(result);
      setError(null);
      return result;
    } catch (cause) {
      setError(errorMessage(cause));
      return null;
    } finally {
      setBusy(false);
    }
  }, [activeProfile]);

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

  const renewHostCredential = useCallback(
    async (hostId: string) => {
      if (!operatorControlBridge || !activeProfile) {
        setError("operator_profile_missing");
        return null;
      }
      setBusy(true);
      try {
        const renewed = await operatorControlBridge.renewOperatorHostCredential({
          profileId: activeProfile.profileId,
          hostId
        });
        setHosts((current) => current.map((host) => (host.id === hostId ? renewed : host)));
        setError(null);
        return renewed;
      } catch (cause) {
        setError(errorMessage(cause));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [activeProfile]
  );

  const registerLocalAgentHost = useCallback(
    async (exposedProfileIds: readonly string[]) => {
      if (!operatorControlBridge || !activeProfile || !activeProfile.hasOperatorCredential) {
        setError("operator_credential_missing");
        return null;
      }
      setBusy(true);
      try {
        const next = await operatorControlBridge.registerOperatorLocalAgentHost({
          profileId: activeProfile.profileId,
          request: {
            expiresAt: nextExpiry(15),
            credentialPolicy: { lifetimeDays: credentialLifetimeDays, renewal: "automatic" }
          },
          exposedProfileIds: [...exposedProfileIds]
        });
        setLocalAgentHost(next);
        setError(null);
        await refreshHosts();
        return next;
      } catch (cause) {
        setError(errorMessage(cause));
        try {
          setLocalAgentHost(
            await operatorControlBridge.getOperatorLocalAgentHostStatus({
              profileId: activeProfile.profileId
            })
          );
        } catch (statusCause) {
          console.warn(
            "Failed to refresh local Agent Host status after registration error.",
            statusCause
          );
        }
        return null;
      } finally {
        setBusy(false);
      }
    },
    [activeProfile, credentialLifetimeDays, refreshHosts]
  );

  const enrollLocalAgentHost = useCallback(
    async (handoff: string, exposedProfileIds: readonly string[]) => {
      if (!operatorControlBridge) {
        setError("operator_bridge_unavailable");
        return null;
      }
      setBusy(true);
      try {
        const next = await operatorControlBridge.enrollOperatorLocalAgentHost({
          handoff,
          exposedProfileIds: [...exposedProfileIds]
        });
        setLocalAgentHost(next);
        setError(null);
        await refreshHosts();
        return next;
      } catch (cause) {
        setError(errorMessage(cause));
        try {
          setLocalAgentHost(
            await operatorControlBridge.getOperatorLocalAgentHostStatus(
              activeProfileId ? { profileId: activeProfileId } : {}
            )
          );
        } catch (statusCause) {
          console.warn(
            "Failed to refresh local Agent Host status after enrollment error.",
            statusCause
          );
        }
        return null;
      } finally {
        setBusy(false);
      }
    },
    [activeProfileId, refreshHosts]
  );

  const repairLocalAgentHost = useCallback(
    async (exposedProfileIds: readonly string[]) => {
      if (!operatorControlBridge) {
        setError("operator_bridge_unavailable");
        return null;
      }
      setBusy(true);
      try {
        const next = await operatorControlBridge.repairOperatorLocalAgentHost({
          ...(activeProfileId ? { profileId: activeProfileId } : {}),
          exposedProfileIds: [...exposedProfileIds]
        });
        setLocalAgentHost(next);
        setError(null);
        await refreshHosts();
        return next;
      } catch (cause) {
        setError(errorMessage(cause));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [activeProfileId, refreshHosts]
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
    memberSetupCodeHandoff,
    localAgentHost,
    localAgentHostLoading,
    credentialLifetimeDays,
    refresh,
    refreshHosts,
    saveProfile,
    removeProfile,
    selectProfile,
    clearActiveProfile,
    importCredential,
    clearCredential,
    copyBootstrapHandoff,
    copyMemberSetupCode,
    revokeHost,
    renewHostCredential,
    setCredentialLifetimeDays,
    registerLocalAgentHost,
    repairLocalAgentHost,
    enrollLocalAgentHost,
    dismissHandoff: () => setHandoff(null),
    dismissMemberSetupCodeHandoff: () => setMemberSetupCodeHandoff(null),
    clearError: () => setError(null)
  };
}
