import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  DesktopAutoRunEvent,
  DesktopBridgeApi,
  DesktopPackageFileChangeEvent,
  DesktopRunnerRecordSubscriptionInput,
  DesktopRunnerRecordSubscriptionPush,
  DesktopRuntimeStateChangeEvent
} from "@planweave-ai/runtime";
import type { AppUpdateState, PlanWeaveAppUpdateApi } from "../shared/appUpdate.js";
import { appUpdateChangedChannel, appUpdateInvokeChannels } from "../shared/appUpdate.js";
import type { PlanWeaveDesktopSettingsApi } from "../shared/desktopSettings.js";
import { desktopSettingsInvokeChannels } from "../shared/desktopSettings.js";
import {
  autoRunChangedChannel,
  packageFileChangedChannel,
  runnerRecordEventChannel,
  runnerRecordSubscribeChannel,
  runnerRecordUnsubscribeChannel,
  runtimeStateChangedChannel
} from "../shared/ipcChannels.js";
import type {
  CollaborationObserverSignal,
  CollaborationPresenceSignal,
  CollaborationStatus,
  PlanWeaveCollaborationApi
} from "../shared/collaboration.js";
import {
  collaborationInvokeChannels,
  collaborationObserverSignalChannel,
  collaborationPresenceSignalChannel,
  collaborationStatusChangedChannel
} from "../shared/collaborationIpc.js";
import type {
  PlanWeaveOperatorControlApi,
  OperatorControlStatus
} from "../shared/operatorControl.js";
import {
  operatorControlInvokeChannels,
  operatorControlStatusChangedChannel
} from "../shared/operatorControlIpc.js";
import type { McpTunnelStatus, PlanWeaveMcpTunnelApi } from "../shared/mcpTunnel.js";
import { mcpTunnelChangedChannel, mcpTunnelInvokeChannels } from "../shared/mcpTunnel.js";
import {
  windowAppearanceInvokeChannels,
  type PlanWeaveWindowApi
} from "../shared/windowAppearance.js";
import { createDesktopBridgeInvokeApi } from "./bridgeInvocation.js";

const invokeApi = createDesktopBridgeInvokeApi((channel, ...args) =>
  ipcRenderer.invoke(channel, ...args)
);
let lastSmokeRevealPath: string | null = null;
let runnerRecordSubscriptionSequence = 0;

function runnerRecordSubscriptionIsTerminal(
  snapshot: Extract<DesktopRunnerRecordSubscriptionPush, { kind: "snapshot" }>["snapshot"]
): boolean {
  return (
    snapshot.terminal &&
    !snapshot.intervention.prompt.available &&
    !snapshot.intervention.prompt.inFlight
  );
}

const api: DesktopBridgeApi = {
  ...invokeApi,
  revealPathInFinder: async (path) => {
    if (process.env.PLANWEAVE_DESKTOP_SMOKE === "1") {
      lastSmokeRevealPath = path;
      return;
    }
    await invokeApi.revealPathInFinder(path);
  },
  onPackageFileChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: DesktopPackageFileChangeEvent) =>
      callback(payload);
    ipcRenderer.on(packageFileChangedChannel, listener);
    return () => ipcRenderer.off(packageFileChangedChannel, listener);
  },
  onRuntimeStateChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: DesktopRuntimeStateChangeEvent) =>
      callback(payload);
    ipcRenderer.on(runtimeStateChangedChannel, listener);
    return () => ipcRenderer.off(runtimeStateChangedChannel, listener);
  },
  onAutoRunChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: DesktopAutoRunEvent) => callback(payload);
    ipcRenderer.on(autoRunChangedChannel, listener);
    return () => ipcRenderer.off(autoRunChangedChannel, listener);
  },
  subscribeRunnerRecord: async (input, callback) => {
    runnerRecordSubscriptionSequence += 1;
    const subscriptionId = `renderer-${runnerRecordSubscriptionSequence}`;
    let active = true;
    const listener = (_event: IpcRendererEvent, payload: DesktopRunnerRecordSubscriptionPush) => {
      if (!active || payload.subscriptionId !== subscriptionId) return;
      if (payload.kind === "closed") {
        active = false;
        ipcRenderer.off(runnerRecordEventChannel, listener);
        callback({
          kind: "closed",
          updateSequence: payload.updateSequence,
          close: payload.close
        });
        return;
      }
      callback({
        kind: "snapshot",
        updateSequence: payload.updateSequence,
        snapshot: payload.snapshot
      });
      if (runnerRecordSubscriptionIsTerminal(payload.snapshot)) {
        active = false;
        ipcRenderer.off(runnerRecordEventChannel, listener);
      }
    };
    ipcRenderer.on(runnerRecordEventChannel, listener);
    const request: DesktopRunnerRecordSubscriptionInput = {
      ...input,
      subscriptionId
    };
    try {
      const start = await ipcRenderer.invoke(runnerRecordSubscribeChannel, request);
      if (start.snapshot && runnerRecordSubscriptionIsTerminal(start.snapshot)) {
        active = false;
        ipcRenderer.off(runnerRecordEventChannel, listener);
      }
      return {
        ...start,
        unsubscribe: async () => {
          if (!active) return;
          active = false;
          ipcRenderer.off(runnerRecordEventChannel, listener);
          await ipcRenderer.invoke(runnerRecordUnsubscribeChannel, subscriptionId);
        }
      };
    } catch (error) {
      active = false;
      ipcRenderer.off(runnerRecordEventChannel, listener);
      throw error;
    }
  }
};

contextBridge.exposeInMainWorld("planweave", api);

const desktopSettingsApi: PlanWeaveDesktopSettingsApi = {
  getDesktopSettings: async () =>
    ipcRenderer.invoke(desktopSettingsInvokeChannels.getDesktopSettings),
  saveDesktopSettings: async (patch) =>
    ipcRenderer.invoke(desktopSettingsInvokeChannels.saveDesktopSettings, patch),
  migrateLegacyDesktopSettings: async (payload) =>
    ipcRenderer.invoke(desktopSettingsInvokeChannels.migrateLegacyDesktopSettings, payload)
};

contextBridge.exposeInMainWorld("planweaveDesktopSettings", desktopSettingsApi);

const windowApi: PlanWeaveWindowApi = {
  getWindowMaterialCapabilities: async () =>
    ipcRenderer.invoke(windowAppearanceInvokeChannels.getWindowMaterialCapabilities),
  setWindowMaterial: async (settings) => {
    await ipcRenderer.invoke(windowAppearanceInvokeChannels.setWindowMaterial, settings);
  }
};

contextBridge.exposeInMainWorld("planweaveWindow", windowApi);

const appUpdateApi: PlanWeaveAppUpdateApi = {
  checkForAppUpdate: async () => ipcRenderer.invoke(appUpdateInvokeChannels.checkForAppUpdate),
  downloadAppUpdate: async () => ipcRenderer.invoke(appUpdateInvokeChannels.downloadAppUpdate),
  getAppUpdateState: async () => ipcRenderer.invoke(appUpdateInvokeChannels.getAppUpdateState),
  installAppUpdate: async () => ipcRenderer.invoke(appUpdateInvokeChannels.installAppUpdate),
  onAppUpdateChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: AppUpdateState) => callback(payload);
    ipcRenderer.on(appUpdateChangedChannel, listener);
    return () => ipcRenderer.off(appUpdateChangedChannel, listener);
  }
};

contextBridge.exposeInMainWorld("planweaveAppUpdate", appUpdateApi);

const mcpTunnelApi: PlanWeaveMcpTunnelApi = {
  getMcpTunnelStatus: async () => ipcRenderer.invoke(mcpTunnelInvokeChannels.getMcpTunnelStatus),
  downloadTunnelClient: async () =>
    ipcRenderer.invoke(mcpTunnelInvokeChannels.downloadTunnelClient),
  setTunnelClientPath: async (path) =>
    ipcRenderer.invoke(mcpTunnelInvokeChannels.setTunnelClientPath, path),
  setTunnelAutoStart: async (enabled) =>
    ipcRenderer.invoke(mcpTunnelInvokeChannels.setTunnelAutoStart, enabled),
  startLocalMcp: async (input) => ipcRenderer.invoke(mcpTunnelInvokeChannels.startLocalMcp, input),
  stopLocalMcp: async () => ipcRenderer.invoke(mcpTunnelInvokeChannels.stopLocalMcp),
  startTunnel: async (input) => ipcRenderer.invoke(mcpTunnelInvokeChannels.startTunnel, input),
  stopTunnel: async () => ipcRenderer.invoke(mcpTunnelInvokeChannels.stopTunnel),
  onMcpTunnelChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: McpTunnelStatus) => callback(payload);
    ipcRenderer.on(mcpTunnelChangedChannel, listener);
    return () => ipcRenderer.off(mcpTunnelChangedChannel, listener);
  }
};

contextBridge.exposeInMainWorld("planweaveMcpTunnel", mcpTunnelApi);

const collaborationApi: PlanWeaveCollaborationApi = {
  getCollaborationStatus: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.getCollaborationStatus),
  upsertCollaborationProfile: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.upsertCollaborationProfile, input),
  removeCollaborationProfile: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.removeCollaborationProfile, input),
  setActiveCollaborationProfile: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.setActiveCollaborationProfile, input),
  clearActiveCollaborationProfile: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.clearActiveCollaborationProfile),
  importDeviceCredential: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.importDeviceCredential, input),
  clearDeviceCredential: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.clearDeviceCredential, input),
  bootstrapCollaborationOwner: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.bootstrapCollaborationOwner, input),
  consumeCollaborationInvitation: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.consumeCollaborationInvitation, input),
  connectCollaborationSession: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.connectCollaborationSession, input),
  disconnectCollaborationSession: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.disconnectCollaborationSession),
  redeemCollaborationSetupCode: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.redeemCollaborationSetupCode, input),
  getActiveWorkspaceConnection: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.getActiveWorkspaceConnection),
  listWorkspacePicker: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.listWorkspacePicker, input),
  selectWorkspaceConnection: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.selectWorkspaceConnection, input),
  connectWorkspaceConnection: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.connectWorkspaceConnection),
  disconnectWorkspaceConnection: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.disconnectWorkspaceConnection),
  retryWorkspaceConnection: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.retryWorkspaceConnection),
  getDeploymentGuidance: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.getDeploymentGuidance, input),
  copyDeploymentComposeHandoff: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.copyDeploymentComposeHandoff, input),
  exportDeploymentComposeBundle: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.exportDeploymentComposeBundle, input),
  validateDeploymentConnectivity: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.validateDeploymentConnectivity, input),
  startCollaborationPresence: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.startCollaborationPresence, input),
  stopCollaborationPresence: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.stopCollaborationPresence),
  publishCollaborationPresence: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.publishCollaborationPresence, input),
  submitCollaborationCanvasCommand: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.submitCollaborationCanvasCommand, input),
  reconnectCollaborationCanvas: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.reconnectCollaborationCanvas, input),
  bindCollaborationCanvasCommandSession: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.bindCollaborationCanvasCommandSession, input),
  getCollaborationCanvasCommandSession: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.getCollaborationCanvasCommandSession),
  bindCollaborationContentAuthority: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.bindCollaborationContentAuthority, input),
  getCollaborationContentAuthority: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.getCollaborationContentAuthority),
  refreshCollaborationContentAuthority: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.refreshCollaborationContentAuthority),
  publishCollaborationInitialContent: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.publishCollaborationInitialContent),
  materializeCollaborationContentHead: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.materializeCollaborationContentHead),
  getCurrentCanvasAccess: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.getCurrentCanvasAccess, input),
  mutateCurrentCanvasAccess: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.mutateCurrentCanvasAccess, input),
  setCollaborationCurrentSelection: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.setCollaborationCurrentSelection, input),
  clearCollaborationCurrentSelection: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.clearCollaborationCurrentSelection),
  getLocalCollaborationServerStatus: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.getLocalCollaborationServerStatus),
  getLocalCollaborationScopeCatalog: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.getLocalCollaborationScopeCatalog),
  setLocalCollaborationTrustedScopes: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.setLocalCollaborationTrustedScopes, input),
  startLocalCollaborationServer: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.startLocalCollaborationServer),
  stopLocalCollaborationServer: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.stopLocalCollaborationServer),
  setLocalCollaborationLanSharing: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.setLocalCollaborationLanSharing, input),
  listLocalCollaborationTrustedScopes: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.listLocalCollaborationTrustedScopes),
  registerLocalCollaborationCurrentProject: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.registerLocalCollaborationCurrentProject, input),
  listCollaborationMembers: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.listCollaborationMembers, input),
  listCollaborationDevices: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.listCollaborationDevices, input),
  listCollaborationInvitations: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.listCollaborationInvitations, input),
  createCollaborationInvitation: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.createCollaborationInvitation, input),
  revokeCollaborationInvitation: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.revokeCollaborationInvitation, input),
  revokeCollaborationInvitations: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.revokeCollaborationInvitations, input),
  removeCollaborationMember: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.removeCollaborationMember, input),
  promoteCollaborationOwner: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.promoteCollaborationOwner, input),
  demoteCollaborationOwner: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.demoteCollaborationOwner, input),
  revokeCollaborationDevice: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.revokeCollaborationDevice, input),
  listCollaborationAssignments: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.listCollaborationAssignments, input),
  getCollaborationAssignment: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.getCollaborationAssignment, input),
  listCollaborationEligibleAssignees: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.listCollaborationEligibleAssignees, input),
  getCollaborationWorkAuthority: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.getCollaborationWorkAuthority, input),
  updateCollaborationResponsibility: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.updateCollaborationResponsibility, input),
  updateCollaborationReviewer: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.updateCollaborationReviewer, input),
  updateCollaborationExecutionTarget: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.updateCollaborationExecutionTarget, input),
  listCollaborationComments: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.listCollaborationComments, input),
  listCollaborationActivity: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.listCollaborationActivity, input),
  listCollaborationAuthorizedProjects: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.listCollaborationAuthorizedProjects, input),
  listCollaborationAuthorizedCanvases: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.listCollaborationAuthorizedCanvases, input),
  readCollaborationPackageSnapshot: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.readCollaborationPackageSnapshot, input),
  createCollaborationPackageSnapshot: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.createCollaborationPackageSnapshot, input),
  restoreCollaborationPackageSnapshot: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.restoreCollaborationPackageSnapshot, input),
  updateCollaborationAssignment: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.updateCollaborationAssignment, input),
  createCollaborationComment: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.createCollaborationComment, input),
  editCollaborationComment: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.editCollaborationComment, input),
  tombstoneCollaborationComment: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.tombstoneCollaborationComment, input),
  createCollaborationPendingAttachment: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.createCollaborationPendingAttachment, input),
  uploadCollaborationPendingAttachment: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.uploadCollaborationPendingAttachment, input),
  finalizeCollaborationPendingAttachment: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.finalizeCollaborationPendingAttachment, input),
  dispatchCollaborationRemoteOperation: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.dispatchCollaborationRemoteOperation, input),
  observeCollaborationRemoteOperation: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.observeCollaborationRemoteOperation, input),
  executeCollaborationRemoteOperationAction: async (input) =>
    ipcRenderer.invoke(
      collaborationInvokeChannels.executeCollaborationRemoteOperationAction,
      input
    ),
  replayCollaborationRemoteOperationEvents: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.replayCollaborationRemoteOperationEvents, input),
  listCollaborationRemoteOperationInteractions: async (input) =>
    ipcRenderer.invoke(
      collaborationInvokeChannels.listCollaborationRemoteOperationInteractions,
      input
    ),
  settleCollaborationRemoteOperationInteraction: async (input) =>
    ipcRenderer.invoke(
      collaborationInvokeChannels.settleCollaborationRemoteOperationInteraction,
      input
    ),
  onCollaborationStatusChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: CollaborationStatus) => callback(payload);
    ipcRenderer.on(collaborationStatusChangedChannel, listener);
    return () => ipcRenderer.off(collaborationStatusChangedChannel, listener);
  },
  onCollaborationObserverSignal: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: CollaborationObserverSignal) =>
      callback(payload);
    ipcRenderer.on(collaborationObserverSignalChannel, listener);
    return () => ipcRenderer.off(collaborationObserverSignalChannel, listener);
  },
  onCollaborationPresenceSignal: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: CollaborationPresenceSignal) =>
      callback(payload);
    ipcRenderer.on(collaborationPresenceSignalChannel, listener);
    return () => ipcRenderer.off(collaborationPresenceSignalChannel, listener);
  }
};

contextBridge.exposeInMainWorld("planweaveCollaboration", collaborationApi);

const operatorControlApi: PlanWeaveOperatorControlApi = {
  getOperatorControlStatus: async () => ipcRenderer.invoke(operatorControlInvokeChannels.getStatus),
  upsertOperatorProfile: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.upsertProfile, input),
  removeOperatorProfile: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.removeProfile, input),
  setActiveOperatorProfile: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.setActiveProfile, input),
  clearActiveOperatorProfile: async () =>
    ipcRenderer.invoke(operatorControlInvokeChannels.clearActiveProfile),
  importOperatorCredential: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.importCredential, input),
  clearOperatorCredential: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.clearCredential, input),
  listOperatorHosts: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.listHosts, input),
  copyOperatorHostBootstrapHandoff: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.copyHostBootstrapHandoff, input),
  copyOperatorMemberSetupCode: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.copyMemberSetupCode, input),
  revokeOperatorHost: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.revokeHost, input),
  onOperatorControlStatusChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: OperatorControlStatus) =>
      callback(payload);
    ipcRenderer.on(operatorControlStatusChangedChannel, listener);
    return () => ipcRenderer.off(operatorControlStatusChangedChannel, listener);
  }
};

contextBridge.exposeInMainWorld("planweaveOperatorControl", operatorControlApi);

if (process.env.PLANWEAVE_DESKTOP_SMOKE === "1") {
  contextBridge.exposeInMainWorld("planweaveSmoke", {
    clearLastRevealPath: () => {
      lastSmokeRevealPath = null;
    },
    getLastRevealPath: () => lastSmokeRevealPath
  });
}
