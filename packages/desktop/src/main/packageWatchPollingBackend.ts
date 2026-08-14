import type { PackageWatchBackendHandle } from "./packageWatchBackend.js";
import {
  changedFingerprint,
  collectWatchedPackageFingerprints,
  diffWatchedPackageSnapshots,
  fingerprintIfPresent,
  mapWithBoundedConcurrency,
  preserveContentHashes,
  type PackageFingerprintSnapshot
} from "./packageWatchFingerprints.js";
import { absolutePathForRelative, type TaskCanvasWorkspace } from "./packageWatchPaths.js";
import {
  PollingWatchLane,
  systemWatchScheduler,
  type WatchScheduler,
  WatchTaskQueue
} from "./watchRuntime.js";

/** Layered polling periods (internal, not user config). */
export const KNOWN_FILE_PROBE_INTERVAL_MS = 1000;
export const INVENTORY_REFRESH_INTERVAL_MS = 10_000;
export const CONTENT_HASH_SWEEP_INTERVAL_MS = 30_000;
export const POLLING_READ_CONCURRENCY = 4;

const PROBE_KICKOFF_MS = 50;
const INVENTORY_KICKOFF_MS = 500;
const HASH_SWEEP_KICKOFF_MS = 25_000;

/** Deterministic exponential backoff caps (ms). */
const PROBE_BACKOFF_BASE_MS = KNOWN_FILE_PROBE_INTERVAL_MS;
const PROBE_BACKOFF_MAX_MS = 16_000;
const INVENTORY_BACKOFF_BASE_MS = INVENTORY_REFRESH_INTERVAL_MS;
const INVENTORY_BACKOFF_MAX_MS = 60_000;
const SWEEP_BACKOFF_BASE_MS = CONTENT_HASH_SWEEP_INTERVAL_MS;
const SWEEP_BACKOFF_MAX_MS = 120_000;

type PollingLane = "probe" | "inventory" | "hash-sweep";

function warnPollingSnapshotFailure(
  workspaceRoot: string,
  lane: PollingLane,
  caught: unknown
): void {
  console.warn(
    `PlanWeave package polling watch [${lane}] failed for '${workspaceRoot}': ${caught instanceof Error ? caught.message : String(caught)}`
  );
}

export async function startPollingPackageWatchBackend(
  workspace: TaskCanvasWorkspace,
  recordChange: (path: string) => void,
  onError?: (error: unknown) => void,
  scheduler: WatchScheduler = systemWatchScheduler
): Promise<PackageWatchBackendHandle> {
  let lastSnapshot: PackageFingerprintSnapshot = new Map();
  let knownRelativePaths: Set<string> = new Set();
  let closed = false;
  const queue = new WatchTaskQueue();

  function emitError(lane: PollingLane, caught: unknown): void {
    warnPollingSnapshotFailure(workspace.workspaceRoot, lane, caught);
    onError?.(caught);
  }

  try {
    lastSnapshot = await collectWatchedPackageFingerprints(workspace);
    knownRelativePaths = new Set(lastSnapshot.keys());
  } catch (caught) {
    emitError("inventory", caught);
    // Proceed with empty known set; inventory will repopulate when healthy.
  }

  async function probeKnownFiles(isCurrent: () => boolean): Promise<void> {
    const next: PackageFingerprintSnapshot = new Map();
    const knownList = Array.from(knownRelativePaths);
    for (const rel of knownList) {
      if (!isCurrent()) {
        return;
      }
      const fingerprint = await fingerprintIfPresent(
        absolutePathForRelative(workspace, rel),
        false
      );
      if (fingerprint) {
        next.set(rel, fingerprint);
      }
    }
    if (!isCurrent()) {
      return;
    }
    const manifestFp = await fingerprintIfPresent(workspace.manifestFile, false);
    if (manifestFp) {
      next.set("package/manifest.json", manifestFp);
    }
    const projectFp = await fingerprintIfPresent(workspace.projectPromptFile, false);
    if (projectFp) {
      next.set("policy/project-prompt.md", projectFp);
    }
    if (!isCurrent()) {
      return;
    }

    const previous = lastSnapshot;
    preserveContentHashes(previous, next);
    for (const path of diffWatchedPackageSnapshots(previous, next)) {
      recordChange(path);
    }
    lastSnapshot = next;
    knownRelativePaths = new Set([...knownRelativePaths, ...next.keys()]);
  }

  async function refreshInventory(isCurrent: () => boolean): Promise<void> {
    const nextSnapshot = await collectWatchedPackageFingerprints(workspace);
    if (!isCurrent()) {
      return;
    }
    const previousSnapshot = lastSnapshot;

    const previousKeys = new Set(previousSnapshot.keys());
    const nextKeys = new Set(nextSnapshot.keys());
    for (const key of nextKeys) {
      if (!previousKeys.has(key)) {
        recordChange(key);
      }
    }
    for (const key of previousKeys) {
      if (!nextKeys.has(key)) {
        recordChange(key);
      }
    }
    // mtime/size edits on known files remain probe's job; inventory only discovers membership.
    // Preserve their prior fingerprints so inventory cannot advance the shared baseline before
    // a concurrent probe has published the change. New paths start from inventory's fingerprint.
    lastSnapshot = new Map(
      [...nextSnapshot].map(([key, fingerprint]) => [key, previousSnapshot.get(key) ?? fingerprint])
    );
    knownRelativePaths = new Set(nextKeys);
  }

  async function hashSweep(isCurrent: () => boolean): Promise<void> {
    const knownList = Array.from(knownRelativePaths);
    const previousSnapshot = lastSnapshot;
    const updates = await mapWithBoundedConcurrency(
      knownList,
      POLLING_READ_CONCURRENCY,
      async (rel) => {
        const newFp = await fingerprintIfPresent(absolutePathForRelative(workspace, rel), true);
        return { rel, newFp };
      }
    );
    if (!isCurrent()) {
      return;
    }

    for (const { rel, newFp } of updates) {
      if (!newFp) {
        continue;
      }
      const old = previousSnapshot.get(rel);
      const current = lastSnapshot.get(rel);
      // A deletion or incompatible probe/inventory commit after this sweep started owns the
      // newer state. Equivalent fingerprints remain safe even if their object identity changed.
      if (!old || !current || changedFingerprint(old, current)) {
        continue;
      }
      let changed = old.mtimeMs !== newFp.mtimeMs || old.size !== newFp.size;
      if (!changed && old.hash && newFp.hash && old.hash !== newFp.hash) {
        changed = true;
      }
      lastSnapshot.set(rel, newFp);
      if (changed) {
        recordChange(rel);
      }
    }
  }

  const lanes = [
    new PollingWatchLane({
      scheduler,
      queue,
      intervalMs: KNOWN_FILE_PROBE_INTERVAL_MS,
      kickoffMs: PROBE_KICKOFF_MS,
      runImmediately: true,
      backoffBaseMs: PROBE_BACKOFF_BASE_MS,
      backoffMaxMs: PROBE_BACKOFF_MAX_MS,
      run: probeKnownFiles,
      onError: (error) => emitError("probe", error)
    }),
    new PollingWatchLane({
      scheduler,
      queue,
      intervalMs: INVENTORY_REFRESH_INTERVAL_MS,
      kickoffMs: INVENTORY_KICKOFF_MS,
      backoffBaseMs: INVENTORY_BACKOFF_BASE_MS,
      backoffMaxMs: INVENTORY_BACKOFF_MAX_MS,
      run: refreshInventory,
      onError: (error) => emitError("inventory", error)
    }),
    new PollingWatchLane({
      scheduler,
      queue,
      intervalMs: CONTENT_HASH_SWEEP_INTERVAL_MS,
      kickoffMs: HASH_SWEEP_KICKOFF_MS,
      backoffBaseMs: SWEEP_BACKOFF_BASE_MS,
      backoffMaxMs: SWEEP_BACKOFF_MAX_MS,
      run: hashSweep,
      onError: (error) => emitError("hash-sweep", error)
    })
  ];
  for (const lane of lanes) {
    lane.start();
  }

  return {
    kind: "polling",
    close() {
      if (closed) {
        return;
      }
      closed = true;
      for (const lane of lanes) {
        lane.close();
      }
      queue.close();
    }
  };
}
