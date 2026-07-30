import type {
  DesktopCanvasReference,
  DesktopOpenRunTerminalInput,
  DesktopOpenTerminalInput,
  DesktopRunTerminalAvailabilityInput
} from "@planweave-ai/runtime";
import {
  assertTerminalAppAvailable,
  detectTerminalApps,
  getTerminalPreferences,
  isDesktopTerminalAppId,
  updateTerminalPreferences
} from "./terminalApps.js";
import { launchRunTerminal, openTerminal } from "./terminalLauncher.js";
import type { RuntimeBridgeHandlerMap } from "./runtimeBridgeHandlerTypes.js";
import {
  getRunTerminalAvailability,
  resolveDesktopTerminalAttachMode,
  resolveTerminalOpenIntent,
  resolveTmuxAttachIntent
} from "./tmuxRunRecordResolver.js";

const maxRunTerminalAvailabilityRecordIds = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseDesktopCanvasReference(value: unknown): DesktopCanvasReference {
  if (!isRecord(value)) {
    throw new Error("Desktop canvas reference is invalid.");
  }
  if (typeof value.projectRoot !== "string" || !value.projectRoot.trim()) {
    throw new Error("Desktop canvas reference projectRoot is invalid.");
  }
  if (
    value.canvasId !== undefined &&
    value.canvasId !== null &&
    typeof value.canvasId !== "string"
  ) {
    throw new Error("Desktop canvas reference canvasId is invalid.");
  }
  return {
    projectRoot: value.projectRoot,
    canvasId: value.canvasId
  };
}

function parseOpenRunTerminalInput(value: unknown): DesktopOpenRunTerminalInput {
  if (!isRecord(value)) {
    throw new Error("Open terminal input must be a JSON object.");
  }
  for (const key of Object.keys(value)) {
    if (key === "command") {
      throw new Error("Renderer must not provide terminal commands.");
    }
    if (key !== "ref" && key !== "recordId" && key !== "appId" && key !== "mode") {
      throw new Error(`Unsupported open terminal field '${key}'.`);
    }
  }
  if (typeof value.recordId !== "string" || !value.recordId.trim()) {
    throw new Error("Open terminal recordId is invalid.");
  }
  if (!isDesktopTerminalAppId(value.appId)) {
    throw new Error("Terminal app id is invalid.");
  }
  const mode = resolveDesktopTerminalAttachMode(value.mode);
  return {
    ref: parseDesktopCanvasReference(value.ref),
    recordId: value.recordId,
    appId: value.appId,
    mode
  };
}

function parseOpenTerminalInput(value: unknown): DesktopOpenTerminalInput {
  if (!isRecord(value)) {
    throw new Error("Open terminal input must be a JSON object.");
  }
  for (const key of Object.keys(value)) {
    if (key === "command") {
      throw new Error("Renderer must not provide terminal commands.");
    }
    if (key !== "ref" && key !== "recordId" && key !== "appId") {
      throw new Error(`Unsupported open terminal field '${key}'.`);
    }
  }
  if (
    value.recordId !== undefined &&
    value.recordId !== null &&
    (typeof value.recordId !== "string" || !value.recordId.trim())
  ) {
    throw new Error("Open terminal recordId is invalid.");
  }
  if (!isDesktopTerminalAppId(value.appId)) {
    throw new Error("Terminal app id is invalid.");
  }
  return {
    ref: parseDesktopCanvasReference(value.ref),
    recordId: value.recordId ?? null,
    appId: value.appId
  };
}

function parseRunTerminalAvailabilityInput(value: unknown): DesktopRunTerminalAvailabilityInput {
  if (!isRecord(value)) {
    throw new Error("Terminal availability input must be a JSON object.");
  }
  for (const key of Object.keys(value)) {
    if (key === "command") {
      throw new Error("Renderer must not provide terminal commands.");
    }
    if (key !== "ref" && key !== "recordIds") {
      throw new Error(`Unsupported terminal availability field '${key}'.`);
    }
  }
  if (
    !Array.isArray(value.recordIds) ||
    value.recordIds.some((recordId) => typeof recordId !== "string" || !recordId.trim())
  ) {
    throw new Error("Terminal availability recordIds are invalid.");
  }
  if (value.recordIds.length > maxRunTerminalAvailabilityRecordIds) {
    throw new Error(
      `Terminal availability recordIds must not exceed ${maxRunTerminalAvailabilityRecordIds}.`
    );
  }
  return {
    ref: parseDesktopCanvasReference(value.ref),
    recordIds: [...new Set(value.recordIds)]
  };
}

export const runtimeBridgeTerminalHandlers = {
  detectTerminalApps: () => detectTerminalApps(),
  getTerminalPreferences: () => getTerminalPreferences(),
  updateTerminalPreferences: (_event, patch) => updateTerminalPreferences(patch),
  getRunTerminalAvailability: async (_event, input) =>
    getRunTerminalAvailability(parseRunTerminalAvailabilityInput(input)),
  openTerminal: async (_event, input) => {
    const parsedInput = parseOpenTerminalInput(input);
    await assertTerminalAppAvailable(parsedInput.appId);
    const intent = await resolveTerminalOpenIntent(parsedInput);
    await openTerminal(parsedInput.appId, intent);
    return {
      appId: parsedInput.appId,
      cwd: intent.cwd
    };
  },
  openRunTerminal: async (_event, input) => {
    const parsedInput = parseOpenRunTerminalInput(input);
    await assertTerminalAppAvailable(parsedInput.appId);
    const intent = await resolveTmuxAttachIntent(parsedInput);
    await launchRunTerminal(parsedInput.appId, intent);
    return {
      appId: parsedInput.appId,
      tmuxSessionId: intent.sessionName,
      mode: intent.mode
    };
  }
} satisfies Partial<RuntimeBridgeHandlerMap>;
