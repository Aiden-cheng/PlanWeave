import { BrowserWindow, ipcMain, safeStorage } from "electron";
import WebSocket from "ws";
import {
  collaborationInvokeChannels,
  collaborationObserverSignalChannel,
  collaborationStatusChangedChannel,
  type CollaborationObserverSignal,
  type CollaborationStatus
} from "../../shared/collaboration.js";
import {
  CollaborationClient,
  type CollaborationWebSocketConstructor
} from "./CollaborationClient.js";
import {
  CollaborationService,
  type CollaborationServiceOptions
} from "./collaborationService.js";

let service: CollaborationService | null = null;

function publishStatusToRenderers(status: CollaborationStatus): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(collaborationStatusChangedChannel, status);
    }
  }
}

function publishObserverSignalToRenderers(signal: CollaborationObserverSignal): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(collaborationObserverSignalChannel, signal);
    }
  }
}

function createDefaultService(options: CollaborationServiceOptions = {}): CollaborationService {
  const userCreateClient = options.createClient;
  return new CollaborationService({
    ...options,
    safeStorage: options.safeStorage ?? {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value)
    },
    createClient:
      userCreateClient ??
      ((clientOptions) =>
        new CollaborationClient({
          ...clientOptions,
          WebSocketImpl:
            clientOptions.WebSocketImpl ??
            (WebSocket as unknown as CollaborationWebSocketConstructor)
        })),
    onStatusChange: options.onStatusChange ?? publishStatusToRenderers,
    onObserverSignal: options.onObserverSignal ?? publishObserverSignalToRenderers
  });
}

export function getCollaborationService(): CollaborationService {
  if (!service) {
    service = createDefaultService();
  }
  return service;
}

/** Test/helper override. */
export function setCollaborationServiceForTests(next: CollaborationService | null): void {
  service = next;
}

export function createCollaborationService(
  options: CollaborationServiceOptions = {}
): CollaborationService {
  return createDefaultService(options);
}

export function registerCollaborationHandlers(
  options: CollaborationServiceOptions = {}
): CollaborationService {
  service = createDefaultService(options);
  const active = service;

  ipcMain.handle(collaborationInvokeChannels.getCollaborationStatus, () => active.getStatus());
  ipcMain.handle(collaborationInvokeChannels.upsertCollaborationProfile, (_event, input: unknown) =>
    active.upsertProfile(input)
  );
  ipcMain.handle(collaborationInvokeChannels.removeCollaborationProfile, (_event, input: unknown) =>
    active.removeProfile(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.setActiveCollaborationProfile,
    (_event, input: unknown) => active.setActiveProfile(input)
  );
  ipcMain.handle(collaborationInvokeChannels.clearActiveCollaborationProfile, () =>
    active.clearActiveProfile()
  );
  ipcMain.handle(collaborationInvokeChannels.importDeviceCredential, (_event, input: unknown) =>
    active.importDeviceCredential(input)
  );
  ipcMain.handle(collaborationInvokeChannels.clearDeviceCredential, (_event, input: unknown) =>
    active.clearDeviceCredential(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.bootstrapCollaborationOwner,
    (_event, input: unknown) => active.bootstrapOwner(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.consumeCollaborationInvitation,
    (_event, input: unknown) => active.consumeInvitation(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.connectCollaborationSession,
    (_event, input: unknown) => active.connectSession(input)
  );
  ipcMain.handle(collaborationInvokeChannels.disconnectCollaborationSession, () =>
    active.disconnectSession()
  );
  ipcMain.handle(collaborationInvokeChannels.listCollaborationMembers, (_event, input: unknown) =>
    active.listMembers(input)
  );
  ipcMain.handle(collaborationInvokeChannels.listCollaborationDevices, (_event, input: unknown) =>
    active.listDevices(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.listCollaborationInvitations,
    (_event, input: unknown) => active.listInvitations(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.listCollaborationAssignments,
    (_event, input: unknown) => active.listAssignments(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.getCollaborationAssignment,
    (_event, input: unknown) => active.getAssignment(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.listCollaborationEligibleAssignees,
    (_event, input: unknown) => active.listEligibleAssignees(input)
  );
  ipcMain.handle(collaborationInvokeChannels.listCollaborationComments, (_event, input: unknown) =>
    active.listComments(input)
  );
  ipcMain.handle(collaborationInvokeChannels.listCollaborationActivity, (_event, input: unknown) =>
    active.listActivity(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.updateCollaborationAssignment,
    (_event, input: unknown) => active.updateAssignment(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.createCollaborationComment,
    (_event, input: unknown) => active.createComment(input)
  );
  ipcMain.handle(collaborationInvokeChannels.editCollaborationComment, (_event, input: unknown) =>
    active.editComment(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.tombstoneCollaborationComment,
    (_event, input: unknown) => active.tombstoneComment(input)
  );

  return active;
}

export async function shutdownCollaborationService(): Promise<void> {
  if (!service) {
    return;
  }
  const active = service;
  service = null;
  await active.shutdown();
}
