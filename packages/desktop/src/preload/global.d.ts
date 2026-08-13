import type { DesktopBridgeApi } from "@planweave-ai/runtime";
import type { PlanWeaveAppUpdateApi } from "../shared/appUpdate";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration";
import type { PlanWeaveDesktopSettingsApi } from "../shared/desktopSettings";
import type { PlanWeaveCredentialStorageSettingsApi } from "../shared/credentialStorageSettings";
import type { PlanWeaveMcpTunnelApi } from "../shared/mcpTunnel";
import type { PlanWeaveOperatorControlApi } from "../shared/operatorControl";
import type { PlanWeaveWindowApi } from "../shared/windowAppearance";

declare global {
  interface Window {
    planweave: DesktopBridgeApi;
    planweaveAppUpdate?: PlanWeaveAppUpdateApi;
    planweaveCollaboration?: PlanWeaveCollaborationApi;
    planweaveDesktopSettings?: PlanWeaveDesktopSettingsApi;
    planweaveCredentialStorageSettings?: PlanWeaveCredentialStorageSettingsApi;
    planweaveMcpTunnel?: PlanWeaveMcpTunnelApi;
    planweaveOperatorControl?: PlanWeaveOperatorControlApi;
    planweaveWindow?: PlanWeaveWindowApi;
  }
}

export {};
