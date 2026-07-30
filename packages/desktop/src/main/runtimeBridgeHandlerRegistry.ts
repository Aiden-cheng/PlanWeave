import { runtimeBridgeAutoRunHandlers } from "./runtimeBridgeAutoRunHandlers.js";
import { runtimeBridgeDesktopShellHandlers } from "./runtimeBridgeDesktopShellHandlers.js";
import { runtimeBridgeGraphHandlers } from "./runtimeBridgeGraphHandlers.js";
import {
  assertDistinctRuntimeBridgeHandlerKeys,
  type RuntimeBridgeHandlerMap
} from "./runtimeBridgeHandlerTypes.js";
import { runtimeBridgePackageSyncHandlers } from "./runtimeBridgePackageSyncHandlers.js";
import { runtimeBridgeProjectHandlers } from "./runtimeBridgeProjectHandlers.js";
import { runtimeBridgeRunnerInteractionHandlers } from "./runtimeBridgeRunnerInteractionHandlers.js";
import { runtimeBridgeTaskWorkspaceHandlers } from "./runtimeBridgeTaskWorkspaceHandlers.js";
import { runtimeBridgeTerminalHandlers } from "./runtimeBridgeTerminalHandlers.js";

const runtimeBridgeHandlerGroups = [
  runtimeBridgeProjectHandlers,
  runtimeBridgeDesktopShellHandlers,
  runtimeBridgeTerminalHandlers,
  runtimeBridgeTaskWorkspaceHandlers,
  runtimeBridgeRunnerInteractionHandlers,
  runtimeBridgeGraphHandlers,
  runtimeBridgePackageSyncHandlers,
  runtimeBridgeAutoRunHandlers
] as const;

assertDistinctRuntimeBridgeHandlerKeys(runtimeBridgeHandlerGroups);

export const runtimeBridgeHandlers = {
  ...runtimeBridgeProjectHandlers,
  ...runtimeBridgeDesktopShellHandlers,
  ...runtimeBridgeTerminalHandlers,
  ...runtimeBridgeTaskWorkspaceHandlers,
  ...runtimeBridgeRunnerInteractionHandlers,
  ...runtimeBridgeGraphHandlers,
  ...runtimeBridgePackageSyncHandlers,
  ...runtimeBridgeAutoRunHandlers
} satisfies RuntimeBridgeHandlerMap;

export type { RuntimeBridgeHandlerMap } from "./runtimeBridgeHandlerTypes.js";
