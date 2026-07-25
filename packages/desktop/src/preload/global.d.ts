import type { DesktopBridgeApi } from "@planweave-ai/runtime";
import type { PlanWeaveAppUpdateApi } from "../shared/appUpdate";
import type { PlanWeaveCollaborationApi } from "../shared/collaboration";
import type { PlanWeaveDesktopSettingsApi } from "../shared/desktopSettings";
import type { PlanWeaveMcpTunnelApi } from "../shared/mcpTunnel";
import type { PlanWeaveWindowApi } from "../shared/windowAppearance";

declare global {
  interface Window {
    planweave: DesktopBridgeApi;
    planweaveAppUpdate?: PlanWeaveAppUpdateApi;
    planweaveCollaboration?: PlanWeaveCollaborationApi;
    planweaveDesktopSettings?: PlanWeaveDesktopSettingsApi;
    planweaveMcpTunnel?: PlanWeaveMcpTunnelApi;
    planweaveWindow?: PlanWeaveWindowApi;
  }
}

export {};
