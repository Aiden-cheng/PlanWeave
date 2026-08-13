import { createHash } from "node:crypto";
import { ipcMain } from "electron";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { resolveTaskCanvasWorkspace } from "@planweave-ai/runtime";
import type { DesktopCanvasReference, DesktopRuntimeStateChangeEvent } from "@planweave-ai/runtime";
import type { WebContents } from "electron";
import { desktopBridgeInvokeChannels, runtimeStateChangedChannel } from "../shared/ipcChannels.js";

type RuntimeStateFingerprint = {
  mtimeMs: number;
  size: number;
  hash: string;
};

type RuntimeStateMetadata = Omit<RuntimeStateFingerprint, "hash">;

type RuntimeStateWatchBackend = {
  kind: "native" | "polling";
  watcher: FSWatcher | null;
  pollTimer: NodeJS.Timeout | null;
  hashSweepTimer: NodeJS.Timeout | null;
  lastFingerprint: RuntimeStateFingerprint | null;
  lastObservedMetadata: RuntimeStateMetadata | null;
  closed: boolean;
};

type RuntimeStateWatchSubscriber = {
  webContents: WebContents;
  onDestroyed: () => void;
};

type RuntimeStateWatch = {
  backend: RuntimeStateWatchBackend;
  subscribers: Map<number, RuntimeStateWatchSubscriber>;
  stateFile: string;
  timer: NodeJS.Timeout | null;
  flushInFlight: boolean;
  flushRequested: boolean;
  flushFailureBackoffMs: number;
  flushRetryNotBeforeMs: number;
  closed: boolean;
};

const runtimeStateWatches = new Map<string, RuntimeStateWatch>();
const pendingRuntimeStateWatchStarts = new Map<string, Promise<RuntimeStateWatch>>();
const pendingRuntimeStateWatchSubscribers = new Map<string, Map<number, WebContents>>();
const runtimeStateWatchDebounceMs = 150;
const runtimeStateWatchPollIntervalMs = 1000;
const runtimeStateWatchHashSweepIntervalMs = 30_000;
const runtimeStateWatchFailureBackoffMaxMs = 16_000;

function watchKey(projectRoot: string, canvasId?: string | null): string {
  return `${projectRoot}::${canvasId ?? "default"}`;
}

function isMissingPathError(caught: unknown): boolean {
  return caught instanceof Error && "code" in caught && caught.code === "ENOENT";
}

async function metadataStateFile(path: string): Promise<RuntimeStateMetadata | null> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) {
      return null;
    }
    return {
      mtimeMs: metadata.mtimeMs,
      size: metadata.size
    };
  } catch (caught) {
    if (isMissingPathError(caught)) {
      return null;
    }
    throw caught;
  }
}

function sameMetadata(
  left: RuntimeStateMetadata | null,
  right: RuntimeStateMetadata | null
): boolean {
  return left?.mtimeMs === right?.mtimeMs && left?.size === right?.size;
}

async function fingerprintStateFile(path: string): Promise<RuntimeStateFingerprint | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await metadataStateFile(path);
    if (!before) {
      return null;
    }
    let content: Buffer;
    try {
      content = await readFile(path);
    } catch (caught) {
      if (isMissingPathError(caught)) {
        continue;
      }
      throw caught;
    }
    const after = await metadataStateFile(path);
    if (!after) {
      return null;
    }
    if (sameMetadata(before, after)) {
      return {
        ...after,
        hash: createHash("sha256").update(content).digest("hex")
      };
    }
  }
  throw new Error(`Runtime state file '${path}' kept changing while it was fingerprinted.`);
}

function changedFingerprint(
  left: RuntimeStateFingerprint | null,
  right: RuntimeStateFingerprint | null
): boolean {
  return (
    left?.mtimeMs !== right?.mtimeMs || left?.size !== right?.size || left?.hash !== right?.hash
  );
}

function warnPollingSnapshotFailure(stateFile: string, caught: unknown): void {
  console.warn(
    `PlanWeave runtime state polling watch failed for '${stateFile}': ${caught instanceof Error ? caught.message : String(caught)}`
  );
}

function nextFailureBackoffMs(currentMs: number): number {
  if (currentMs <= 0) {
    return runtimeStateWatchPollIntervalMs;
  }
  return Math.min(runtimeStateWatchFailureBackoffMaxMs, currentMs * 2);
}

function startNativeRuntimeStateWatchBackend(
  stateFile: string,
  lastFingerprint: RuntimeStateFingerprint | null,
  recordChange: () => void
): RuntimeStateWatchBackend | null {
  const parentDir = dirname(stateFile);
  if (!existsSync(parentDir)) {
    return null;
  }
  const stateFileName = basename(stateFile);
  try {
    const watcher = watch(parentDir, { recursive: false }, (_eventType, filename) => {
      if (!filename || filename.toString() === stateFileName) {
        recordChange();
      }
    });
    return {
      kind: "native",
      watcher,
      pollTimer: null,
      hashSweepTimer: null,
      lastFingerprint,
      lastObservedMetadata: lastFingerprint,
      closed: false
    };
  } catch (caught) {
    console.warn(
      `PlanWeave native runtime state watch failed for '${stateFile}': ${caught instanceof Error ? caught.message : String(caught)}`
    );
    return null;
  }
}

async function startPollingRuntimeStateWatchBackend(
  stateFile: string,
  lastFingerprint: RuntimeStateFingerprint | null,
  recordChange: () => void
): Promise<RuntimeStateWatchBackend> {
  const backend: RuntimeStateWatchBackend = {
    kind: "polling",
    watcher: null,
    pollTimer: null,
    hashSweepTimer: null,
    lastFingerprint,
    lastObservedMetadata: lastFingerprint,
    closed: false
  };
  let pollInFlight = false;
  let pollFailureBackoffMs = 0;

  const schedulePoll = (delayMs: number) => {
    if (backend.closed) {
      return;
    }
    backend.pollTimer = setTimeout(() => {
      backend.pollTimer = null;
      void poll();
    }, delayMs);
  };
  const poll = async () => {
    if (backend.closed || pollInFlight) {
      return;
    }
    pollInFlight = true;
    try {
      const nextMetadata = await metadataStateFile(stateFile);
      if (backend.closed) {
        return;
      }
      const changed = !sameMetadata(backend.lastObservedMetadata, nextMetadata);
      backend.lastObservedMetadata = nextMetadata;
      pollFailureBackoffMs = 0;
      if (changed) {
        recordChange();
      }
    } catch (caught) {
      if (!backend.closed) {
        warnPollingSnapshotFailure(stateFile, caught);
        pollFailureBackoffMs = nextFailureBackoffMs(pollFailureBackoffMs);
      }
    } finally {
      pollInFlight = false;
      schedulePoll(pollFailureBackoffMs || runtimeStateWatchPollIntervalMs);
    }
  };
  schedulePoll(runtimeStateWatchPollIntervalMs);
  backend.hashSweepTimer = setInterval(() => {
    if (!backend.closed) {
      recordChange();
    }
  }, runtimeStateWatchHashSweepIntervalMs);
  return backend;
}

async function startRuntimeStateWatchBackend(
  stateFile: string,
  recordChange: () => void
): Promise<RuntimeStateWatchBackend> {
  const lastFingerprint = await fingerprintStateFile(stateFile);
  return (
    startNativeRuntimeStateWatchBackend(stateFile, lastFingerprint, recordChange) ??
    (await startPollingRuntimeStateWatchBackend(stateFile, lastFingerprint, recordChange))
  );
}

function addPendingRuntimeStateWatchSubscriber(key: string, webContents: WebContents): void {
  const subscribers =
    pendingRuntimeStateWatchSubscribers.get(key) ?? new Map<number, WebContents>();
  subscribers.set(webContents.id, webContents);
  pendingRuntimeStateWatchSubscribers.set(key, subscribers);
}

function removePendingRuntimeStateWatchSubscriber(key: string, webContentsId: number): void {
  const subscribers = pendingRuntimeStateWatchSubscribers.get(key);
  if (!subscribers) {
    return;
  }
  subscribers.delete(webContentsId);
  if (subscribers.size === 0) {
    pendingRuntimeStateWatchSubscribers.delete(key);
  }
}

function hasPendingRuntimeStateWatchSubscribers(key: string): boolean {
  return (pendingRuntimeStateWatchSubscribers.get(key)?.size ?? 0) > 0;
}

function hasPendingRuntimeStateWatchSubscriber(key: string, webContentsId: number): boolean {
  return pendingRuntimeStateWatchSubscribers.get(key)?.has(webContentsId) ?? false;
}

function closeRuntimeStateWatch(activeWatch: RuntimeStateWatch): void {
  if (activeWatch.closed) {
    return;
  }
  activeWatch.closed = true;
  activeWatch.backend.closed = true;
  for (const subscriber of activeWatch.subscribers.values()) {
    subscriber.webContents.removeListener("destroyed", subscriber.onDestroyed);
  }
  activeWatch.subscribers.clear();
  activeWatch.backend.watcher?.close();
  if (activeWatch.backend.pollTimer) {
    clearTimeout(activeWatch.backend.pollTimer);
  }
  if (activeWatch.backend.hashSweepTimer) {
    clearInterval(activeWatch.backend.hashSweepTimer);
  }
  if (activeWatch.timer) {
    clearTimeout(activeWatch.timer);
  }
}

function scheduleRuntimeStateFlush(
  activeWatch: RuntimeStateWatch,
  projectRoot: string,
  canvasId: string | null | undefined,
  delayMs: number
): void {
  if (activeWatch.closed) {
    return;
  }
  const now = Date.now();
  const scheduledAt =
    activeWatch.flushRetryNotBeforeMs > 0
      ? Math.max(now, activeWatch.flushRetryNotBeforeMs)
      : now + delayMs;
  if (activeWatch.timer) {
    if (activeWatch.flushRetryNotBeforeMs > 0) {
      return;
    }
    clearTimeout(activeWatch.timer);
  }
  activeWatch.timer = setTimeout(
    () => {
      void flushRuntimeStateChange(projectRoot, canvasId);
    },
    Math.max(0, scheduledAt - now)
  );
}

async function flushRuntimeStateChange(
  projectRoot: string,
  canvasId?: string | null
): Promise<void> {
  const key = watchKey(projectRoot, canvasId);
  const activeWatch = runtimeStateWatches.get(key);
  if (!activeWatch || activeWatch.closed) {
    return;
  }
  activeWatch.timer = null;
  if (activeWatch.flushInFlight) {
    activeWatch.flushRequested = true;
    return;
  }
  activeWatch.flushInFlight = true;
  activeWatch.flushRequested = false;
  try {
    const nextFingerprint = await fingerprintStateFile(activeWatch.stateFile);
    if (
      activeWatch.closed ||
      runtimeStateWatches.get(key) !== activeWatch ||
      !changedFingerprint(activeWatch.backend.lastFingerprint, nextFingerprint)
    ) {
      activeWatch.flushFailureBackoffMs = 0;
      activeWatch.flushRetryNotBeforeMs = 0;
      return;
    }
    activeWatch.backend.lastFingerprint = nextFingerprint;
    activeWatch.flushFailureBackoffMs = 0;
    activeWatch.flushRetryNotBeforeMs = 0;
    const payload: DesktopRuntimeStateChangeEvent = {
      projectRoot,
      canvasId: canvasId ?? null,
      stateFile: activeWatch.stateFile,
      changedAt: new Date().toISOString()
    };
    for (const subscriber of activeWatch.subscribers.values()) {
      if (!subscriber.webContents.isDestroyed()) {
        subscriber.webContents.send(runtimeStateChangedChannel, payload);
      }
    }
  } catch (caught) {
    if (!activeWatch.closed && runtimeStateWatches.get(key) === activeWatch) {
      activeWatch.flushFailureBackoffMs = nextFailureBackoffMs(activeWatch.flushFailureBackoffMs);
      activeWatch.flushRetryNotBeforeMs = Date.now() + activeWatch.flushFailureBackoffMs;
      console.warn(
        `PlanWeave runtime state watch flush failed for '${activeWatch.stateFile}': ${caught instanceof Error ? caught.message : String(caught)}`
      );
      scheduleRuntimeStateFlush(activeWatch, projectRoot, canvasId, 0);
    }
  } finally {
    activeWatch.flushInFlight = false;
    if (
      activeWatch.flushRequested &&
      !activeWatch.closed &&
      runtimeStateWatches.get(key) === activeWatch
    ) {
      activeWatch.flushRequested = false;
      scheduleRuntimeStateFlush(activeWatch, projectRoot, canvasId, runtimeStateWatchDebounceMs);
    }
  }
}

async function getOrCreateRuntimeStateWatch(
  key: string,
  projectRoot: string,
  canvasId: string | null | undefined
): Promise<RuntimeStateWatch> {
  const activeWatch = runtimeStateWatches.get(key);
  if (activeWatch) {
    return activeWatch;
  }
  const pendingStart = pendingRuntimeStateWatchStarts.get(key);
  if (pendingStart) {
    return pendingStart;
  }
  const start = (async () => {
    const workspace = await resolveTaskCanvasWorkspace(projectRoot, canvasId);
    const recordChange = () => {
      const currentWatch = runtimeStateWatches.get(key);
      if (!currentWatch || currentWatch.closed) {
        return;
      }
      if (currentWatch.flushInFlight) {
        currentWatch.flushRequested = true;
        return;
      }
      if (currentWatch.flushRetryNotBeforeMs > 0) {
        currentWatch.flushRequested = true;
      }
      scheduleRuntimeStateFlush(currentWatch, projectRoot, canvasId, runtimeStateWatchDebounceMs);
    };
    const backend = await startRuntimeStateWatchBackend(workspace.stateFile, recordChange);
    const createdWatch: RuntimeStateWatch = {
      backend,
      subscribers: new Map(),
      stateFile: workspace.stateFile,
      timer: null,
      flushInFlight: false,
      flushRequested: false,
      flushFailureBackoffMs: 0,
      flushRetryNotBeforeMs: 0,
      closed: false
    };
    if (!hasPendingRuntimeStateWatchSubscribers(key)) {
      closeRuntimeStateWatch(createdWatch);
      return createdWatch;
    }
    runtimeStateWatches.set(key, createdWatch);
    return createdWatch;
  })();
  pendingRuntimeStateWatchStarts.set(key, start);
  try {
    return await start;
  } finally {
    pendingRuntimeStateWatchStarts.delete(key);
  }
}

async function startRuntimeStateWatch(
  projectRoot: string,
  canvasId: string | null | undefined,
  webContents: WebContents
): Promise<void> {
  const key = watchKey(projectRoot, canvasId);
  addPendingRuntimeStateWatchSubscriber(key, webContents);
  let activeWatch: RuntimeStateWatch;
  try {
    activeWatch = await getOrCreateRuntimeStateWatch(key, projectRoot, canvasId);
  } catch (caught) {
    removePendingRuntimeStateWatchSubscriber(key, webContents.id);
    throw caught;
  }
  if (!hasPendingRuntimeStateWatchSubscriber(key, webContents.id) || webContents.isDestroyed()) {
    removePendingRuntimeStateWatchSubscriber(key, webContents.id);
    if (activeWatch.subscribers.size === 0 && !hasPendingRuntimeStateWatchSubscribers(key)) {
      closeRuntimeStateWatch(activeWatch);
      if (runtimeStateWatches.get(key) === activeWatch) {
        runtimeStateWatches.delete(key);
      }
    }
    return;
  }
  if (!activeWatch.subscribers.has(webContents.id)) {
    const onDestroyed = () => stopRuntimeStateWatch(projectRoot, canvasId, webContents);
    activeWatch.subscribers.set(webContents.id, { webContents, onDestroyed });
    webContents.once("destroyed", onDestroyed);
  }
  removePendingRuntimeStateWatchSubscriber(key, webContents.id);
}

function stopRuntimeStateWatch(
  projectRoot: string,
  canvasId: string | null | undefined,
  webContents: WebContents
): void {
  const key = watchKey(projectRoot, canvasId);
  removePendingRuntimeStateWatchSubscriber(key, webContents.id);
  const activeWatch = runtimeStateWatches.get(key);
  if (!activeWatch) {
    return;
  }
  const subscriber = activeWatch.subscribers.get(webContents.id);
  if (!subscriber) {
    if (activeWatch.subscribers.size === 0 && !hasPendingRuntimeStateWatchSubscribers(key)) {
      closeRuntimeStateWatch(activeWatch);
      runtimeStateWatches.delete(key);
    }
    return;
  }
  activeWatch.subscribers.delete(webContents.id);
  subscriber.webContents.removeListener("destroyed", subscriber.onDestroyed);
  if (activeWatch.subscribers.size > 0 || hasPendingRuntimeStateWatchSubscribers(key)) {
    return;
  }
  closeRuntimeStateWatch(activeWatch);
  runtimeStateWatches.delete(key);
}

export function registerRuntimeStateWatchHandlers(): void {
  ipcMain.handle(
    desktopBridgeInvokeChannels.watchRuntimeState,
    (event, ref: DesktopCanvasReference) =>
      startRuntimeStateWatch(ref.projectRoot, ref.canvasId, event.sender)
  );
  ipcMain.handle(
    desktopBridgeInvokeChannels.unwatchRuntimeState,
    (event, ref: DesktopCanvasReference) =>
      stopRuntimeStateWatch(ref.projectRoot, ref.canvasId, event.sender)
  );
}
