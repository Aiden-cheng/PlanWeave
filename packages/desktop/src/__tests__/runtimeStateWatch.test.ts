import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopBridgeInvokeChannels, runtimeStateChangedChannel } from "../shared/ipcChannels";

type RegisteredHandler = (
  event: { sender: TestWebContents },
  ref: { projectRoot: string; canvasId?: string | null }
) => unknown;
type WatchCallback = (eventType: string, filename: string | Buffer | null) => void;

type TestWebContents = {
  id: number;
  send: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
  once: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
};

type TestWorkspace = {
  rootPath: string;
  workspaceRoot: string;
  stateFile: string;
};

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, RegisteredHandler>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: RegisteredHandler) => {
        handlers.set(channel, handler);
      })
    }
  };
});

const fsMock = vi.hoisted(() => {
  const watchers: Array<{
    rootPath: string;
    options: { recursive?: boolean };
    callback: WatchCallback;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  return {
    watchers,
    watch: vi.fn((rootPath: string, options: { recursive?: boolean }, callback: WatchCallback) => {
      const watcher = {
        rootPath,
        options,
        callback,
        close: vi.fn()
      };
      watchers.push(watcher);
      return watcher;
    })
  };
});

const fsPromisesMock = vi.hoisted(() => {
  const state = {
    activeReadFiles: 0,
    failStat: false,
    maxActiveReadFiles: 0,
    readFileCalls: 0,
    readFileCallHook: null as null | ((path: string) => void),
    readFileHook: null as null | ((path: string) => Buffer | Promise<Buffer> | undefined),
    readFileResultHook: null as null | ((path: string) => void),
    statResultHook: null as null | ((path: string) => void)
  };
  return {
    state,
    reset() {
      state.activeReadFiles = 0;
      state.failStat = false;
      state.maxActiveReadFiles = 0;
      state.readFileCalls = 0;
      state.readFileCallHook = null;
      state.readFileHook = null;
      state.readFileResultHook = null;
      state.statResultHook = null;
    }
  };
});

const runtimeMock = vi.hoisted(() => {
  const state = {
    workspace: null as TestWorkspace | null
  };
  return {
    state,
    resolveTaskCanvasWorkspace: vi.fn(async () => {
      if (!state.workspace) {
        throw new Error("Test workspace is not configured.");
      }
      return state.workspace;
    })
  };
});

vi.mock("electron", () => ({
  ipcMain: electronMock.ipcMain
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    watch: fsMock.watch
  };
});

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    readFile: async (path: Parameters<typeof actual.readFile>[0]) => {
      const normalizedPath = String(path);
      fsPromisesMock.state.readFileCalls += 1;
      fsPromisesMock.state.readFileCallHook?.(normalizedPath);
      fsPromisesMock.state.activeReadFiles += 1;
      fsPromisesMock.state.maxActiveReadFiles = Math.max(
        fsPromisesMock.state.maxActiveReadFiles,
        fsPromisesMock.state.activeReadFiles
      );
      try {
        const hooked = fsPromisesMock.state.readFileHook?.(normalizedPath);
        const result = hooked === undefined ? await actual.readFile(path) : await hooked;
        fsPromisesMock.state.readFileResultHook?.(normalizedPath);
        return result;
      } finally {
        fsPromisesMock.state.activeReadFiles -= 1;
      }
    },
    stat: async (path: Parameters<typeof actual.stat>[0]) => {
      const normalizedPath = String(path);
      if (fsPromisesMock.state.failStat) {
        throw new Error("simulated stat failure");
      }
      const result = await actual.stat(path);
      fsPromisesMock.state.statResultHook?.(normalizedPath);
      return result;
    }
  };
});

vi.mock("@planweave-ai/runtime", () => ({
  resolveTaskCanvasWorkspace: runtimeMock.resolveTaskCanvasWorkspace
}));

const tempRoots: string[] = [];
const activeWatches: Array<{
  webContents: TestWebContents;
  workspace: TestWorkspace;
}> = [];

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function createWorkspace(): Promise<TestWorkspace> {
  const rootPath = await mkdtemp(join(tmpdir(), "planweave-runtime-state-watch-"));
  tempRoots.push(rootPath);
  const canvasRoot = join(rootPath, "canvases", "canvas-a");
  await mkdir(canvasRoot, { recursive: true });
  const stateFile = join(canvasRoot, "state.json");
  await writeFile(stateFile, JSON.stringify({ version: 1, tasks: {} }), "utf8");
  return {
    rootPath,
    workspaceRoot: canvasRoot,
    stateFile
  };
}

function createWebContents(id = 1): TestWebContents {
  return {
    id,
    send: vi.fn(),
    isDestroyed: () => false,
    once: vi.fn(),
    removeListener: vi.fn()
  };
}

async function registerAndWatch(
  webContents: TestWebContents,
  workspace: TestWorkspace
): Promise<void> {
  runtimeMock.state.workspace = workspace;
  const { registerRuntimeStateWatchHandlers } = await import("../main/runtimeStateWatch");
  registerRuntimeStateWatchHandlers();
  const handler = electronMock.handlers.get(desktopBridgeInvokeChannels.watchRuntimeState);
  expect(handler).toBeDefined();
  await handler?.(
    { sender: webContents },
    { projectRoot: workspace.rootPath, canvasId: "canvas-a" }
  );
  activeWatches.push({ webContents, workspace });
}

async function unwatch(webContents: TestWebContents, workspace: TestWorkspace): Promise<void> {
  const handler = electronMock.handlers.get(desktopBridgeInvokeChannels.unwatchRuntimeState);
  expect(handler).toBeDefined();
  await handler?.(
    { sender: webContents },
    { projectRoot: workspace.rootPath, canvasId: "canvas-a" }
  );
  const activeWatchIndex = activeWatches.findIndex(
    (activeWatch) => activeWatch.webContents === webContents && activeWatch.workspace === workspace
  );
  if (activeWatchIndex >= 0) {
    activeWatches.splice(activeWatchIndex, 1);
  }
}

async function flushDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(150);
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

async function advanceUntilStateStat(ms: number, stateFile: string): Promise<void> {
  const completed = createDeferred<void>();
  fsPromisesMock.state.statResultHook = (path) => {
    if (path === stateFile) {
      completed.resolve();
    }
  };
  await vi.advanceTimersByTimeAsync(ms);
  await completed.promise;
  fsPromisesMock.state.statResultHook = null;
  await flushMicrotasks();
}

async function advanceUntilFingerprint(ms: number, stateFile: string): Promise<void> {
  const completed = createDeferred<void>();
  let contentRead = false;
  fsPromisesMock.state.readFileResultHook = (path) => {
    if (path === stateFile) {
      contentRead = true;
    }
  };
  fsPromisesMock.state.statResultHook = (path) => {
    if (path === stateFile && contentRead) {
      completed.resolve();
    }
  };
  await vi.advanceTimersByTimeAsync(ms);
  await completed.promise;
  fsPromisesMock.state.readFileResultHook = null;
  fsPromisesMock.state.statResultHook = null;
  await flushMicrotasks();
}

async function advanceUntilReadFileCall(
  ms: number,
  stateFile: string,
  expectedCalls: number
): Promise<void> {
  const started = createDeferred<void>();
  fsPromisesMock.state.readFileCallHook = (path) => {
    if (path === stateFile && fsPromisesMock.state.readFileCalls >= expectedCalls) {
      started.resolve();
    }
  };
  await vi.advanceTimersByTimeAsync(ms);
  await started.promise;
  fsPromisesMock.state.readFileCallHook = null;
  await flushMicrotasks();
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("runtime state watcher", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    electronMock.handlers.clear();
    electronMock.ipcMain.handle.mockClear();
    fsMock.watchers.length = 0;
    fsMock.watch.mockClear();
    fsPromisesMock.reset();
    runtimeMock.state.workspace = null;
    runtimeMock.resolveTaskCanvasWorkspace.mockClear();
  });

  afterEach(async () => {
    for (const { webContents, workspace } of activeWatches.splice(0)) {
      await unwatch(webContents, workspace);
    }
    vi.useRealTimers();
    await Promise.all(
      tempRoots.splice(0).map((rootPath) => rm(rootPath, { recursive: true, force: true }))
    );
  });

  it("notifies subscribers when the current canvas state file changes", async () => {
    vi.useRealTimers();
    const workspace = await createWorkspace();
    const webContents = createWebContents();

    await registerAndWatch(webContents, workspace);

    expect(fsMock.watch).toHaveBeenCalledWith(
      join(workspace.rootPath, "canvases", "canvas-a"),
      { recursive: false },
      expect.any(Function)
    );
    const watcher = fsMock.watchers[0];
    expect(watcher).toBeDefined();

    await writeFile(
      workspace.stateFile,
      JSON.stringify({ version: 1, tasks: { "T-001": "done" } }),
      "utf8"
    );
    watcher?.callback("change", "state.json");
    await wait(250);

    expect(webContents.send).toHaveBeenCalledWith(
      runtimeStateChangedChannel,
      expect.objectContaining({
        projectRoot: workspace.rootPath,
        canvasId: "canvas-a",
        stateFile: workspace.stateFile,
        changedAt: expect.any(String)
      })
    );
  });

  it("does not notify for non-state files in the watched directory", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();

    await registerAndWatch(webContents, workspace);
    fsMock.watchers[0]?.callback("change", "manifest.json");
    await flushDebounce();

    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("stops native watchers after unwatch", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();

    await registerAndWatch(webContents, workspace);
    await unwatch(webContents, workspace);

    expect(fsMock.watchers[0]?.close).toHaveBeenCalled();
    await writeFile(
      workspace.stateFile,
      JSON.stringify({ version: 1, tasks: { "T-001": "done" } }),
      "utf8"
    );
    fsMock.watchers[0]?.callback("change", "state.json");
    await flushDebounce();

    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("polling fallback detects metadata changes without hashing unchanged ticks", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    fsMock.watch.mockImplementationOnce(() => {
      throw new Error("native watch unsupported");
    });

    await registerAndWatch(webContents, workspace);
    fsPromisesMock.state.readFileCalls = 0;
    await advanceUntilStateStat(1000, workspace.stateFile);
    expect(fsPromisesMock.state.readFileCalls).toBe(0);

    await writeFile(
      workspace.stateFile,
      JSON.stringify({ version: 2, tasks: { "T-001": "completed" } }),
      "utf8"
    );
    await advanceUntilStateStat(1000, workspace.stateFile);
    await advanceUntilFingerprint(150, workspace.stateFile);

    expect(webContents.send).toHaveBeenCalledWith(
      runtimeStateChangedChannel,
      expect.objectContaining({
        projectRoot: workspace.rootPath,
        canvasId: "canvas-a",
        stateFile: workspace.stateFile
      })
    );
    expect(fsPromisesMock.state.readFileCalls).toBe(1);
  });

  it("polling hash sweep detects same-size same-mtime edits", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const pinned = new Date("2020-01-01T00:00:00.000Z");
    await utimes(workspace.stateFile, pinned, pinned);
    fsMock.watch.mockImplementationOnce(() => {
      throw new Error("native watch unsupported");
    });

    await registerAndWatch(webContents, workspace);
    const original = await readFile(workspace.stateFile);
    const replacement = Buffer.alloc(original.length, 0x20);
    await writeFile(workspace.stateFile, replacement);
    await utimes(workspace.stateFile, pinned, pinned);

    await vi.advanceTimersByTimeAsync(29_000);
    await flushMicrotasks();
    expect(webContents.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    await advanceUntilFingerprint(150, workspace.stateFile);
    expect(webContents.send).toHaveBeenCalledTimes(1);
  });

  it("keeps slow fingerprint reads single-flight across polling sweeps", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const heldRead = createDeferred<Buffer>();
    const readStarted = createDeferred<void>();
    fsMock.watch.mockImplementationOnce(() => {
      throw new Error("native watch unsupported");
    });

    await registerAndWatch(webContents, workspace);
    fsPromisesMock.state.readFileCalls = 0;
    fsPromisesMock.state.maxActiveReadFiles = 0;
    fsPromisesMock.state.readFileHook = (path) => {
      if (path === workspace.stateFile) {
        readStarted.resolve();
        return heldRead.promise;
      }
    };

    await vi.advanceTimersByTimeAsync(30_150);
    await readStarted.promise;
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    expect(fsPromisesMock.state.readFileCalls).toBe(1);
    expect(fsPromisesMock.state.maxActiveReadFiles).toBe(1);
    heldRead.resolve(Buffer.from("stale"));
    fsPromisesMock.state.readFileHook = null;
    await flushMicrotasks();
  });

  it("does not publish an in-flight fingerprint after unwatch", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const replacement = Buffer.from(JSON.stringify({ version: 2, tasks: {} }));
    const heldRead = createDeferred<Buffer>();
    const readStarted = createDeferred<void>();

    await registerAndWatch(webContents, workspace);
    await writeFile(workspace.stateFile, replacement);
    fsPromisesMock.state.readFileHook = (path) => {
      if (path === workspace.stateFile) {
        readStarted.resolve();
        return heldRead.promise;
      }
    };
    fsMock.watchers[0]?.callback("change", "state.json");
    await vi.advanceTimersByTimeAsync(150);
    await readStarted.promise;

    await unwatch(webContents, workspace);
    heldRead.resolve(replacement);
    fsPromisesMock.state.readFileHook = null;
    await flushMicrotasks();

    expect(webContents.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps fingerprint retry deadlines under a native event storm and resets after recovery", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await registerAndWatch(webContents, workspace);
      await writeFile(
        workspace.stateFile,
        JSON.stringify({ version: 2, tasks: { "T-001": "completed" } }),
        "utf8"
      );
      fsPromisesMock.state.readFileCalls = 0;
      fsPromisesMock.state.readFileHook = (path) => {
        if (path === workspace.stateFile) {
          throw new Error("simulated fingerprint failure");
        }
      };

      fsMock.watchers[0]?.callback("change", "state.json");
      await advanceUntilReadFileCall(150, workspace.stateFile, 1);
      expect(fsPromisesMock.state.readFileCalls).toBe(1);

      for (let index = 0; index < 9; index += 1) {
        fsMock.watchers[0]?.callback("change", "state.json");
        await vi.advanceTimersByTimeAsync(100);
        await flushMicrotasks();
      }
      await vi.advanceTimersByTimeAsync(99);
      await flushMicrotasks();
      expect(fsPromisesMock.state.readFileCalls).toBe(1);

      await advanceUntilReadFileCall(1, workspace.stateFile, 2);
      expect(fsPromisesMock.state.readFileCalls).toBe(2);

      fsPromisesMock.state.readFileHook = null;
      for (let index = 0; index < 19; index += 1) {
        fsMock.watchers[0]?.callback("change", "state.json");
        await vi.advanceTimersByTimeAsync(100);
        await flushMicrotasks();
      }
      await vi.advanceTimersByTimeAsync(99);
      await flushMicrotasks();
      expect(fsPromisesMock.state.readFileCalls).toBe(2);

      await advanceUntilFingerprint(1, workspace.stateFile);
      expect(webContents.send).toHaveBeenCalledTimes(1);

      await writeFile(
        workspace.stateFile,
        JSON.stringify({ version: 3, tasks: { "T-001": "completed", "T-002": "ready" } }),
        "utf8"
      );
      fsPromisesMock.state.readFileHook = (path) => {
        if (path === workspace.stateFile) {
          throw new Error("simulated fingerprint failure after recovery");
        }
      };
      const callsBeforeRecoveredFailure = fsPromisesMock.state.readFileCalls;
      fsMock.watchers[0]?.callback("change", "state.json");
      await advanceUntilReadFileCall(150, workspace.stateFile, callsBeforeRecoveredFailure + 1);
      expect(fsPromisesMock.state.readFileCalls).toBe(callsBeforeRecoveredFailure + 1);

      for (let index = 0; index < 9; index += 1) {
        fsMock.watchers[0]?.callback("change", "state.json");
        await vi.advanceTimersByTimeAsync(100);
        await flushMicrotasks();
      }
      await vi.advanceTimersByTimeAsync(99);
      await flushMicrotasks();
      expect(fsPromisesMock.state.readFileCalls).toBe(callsBeforeRecoveredFailure + 1);
      await advanceUntilReadFileCall(1, workspace.stateFile, callsBeforeRecoveredFailure + 2);
      expect(fsPromisesMock.state.readFileCalls).toBe(callsBeforeRecoveredFailure + 2);
      expect(webContents.send).toHaveBeenCalledTimes(1);
    } finally {
      fsPromisesMock.state.readFileHook = null;
      await unwatch(webContents, workspace);
      warnSpy.mockRestore();
    }
  });

  it("backs off repeated polling failures and resumes fast probes after recovery", async () => {
    const workspace = await createWorkspace();
    const webContents = createWebContents();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fsMock.watch.mockImplementationOnce(() => {
      throw new Error("native watch unsupported");
    });

    try {
      await registerAndWatch(webContents, workspace);
      warnSpy.mockClear();
      fsPromisesMock.state.failStat = true;

      await vi.advanceTimersByTimeAsync(1000);
      await flushMicrotasks();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      await flushMicrotasks();
      expect(warnSpy).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
      await flushMicrotasks();
      expect(warnSpy).toHaveBeenCalledTimes(2);

      fsPromisesMock.state.failStat = false;
      await advanceUntilStateStat(1000, workspace.stateFile);
      await writeFile(
        workspace.stateFile,
        JSON.stringify({ version: 3, tasks: { recovered: true } }),
        "utf8"
      );
      await advanceUntilStateStat(1000, workspace.stateFile);
      await advanceUntilFingerprint(150, workspace.stateFile);

      expect(webContents.send).toHaveBeenCalledTimes(1);
    } finally {
      fsPromisesMock.state.failStat = false;
      warnSpy.mockRestore();
    }
  });
});
