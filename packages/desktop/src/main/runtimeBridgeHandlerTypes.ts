import type { DesktopBridgeApi } from "@planweave-ai/runtime";
import type { IpcMainInvokeEvent } from "electron";
import type { DesktopBridgeMainInvokeMethod } from "../shared/ipcChannels.js";

export type RuntimeBridgeHandler<M extends DesktopBridgeMainInvokeMethod> = (
  event: IpcMainInvokeEvent,
  ...args: Parameters<DesktopBridgeApi[M]>
) =>
  | Awaited<ReturnType<DesktopBridgeApi[M]>>
  | ReturnType<DesktopBridgeApi[M]>
  | Promise<Awaited<ReturnType<DesktopBridgeApi[M]>>>;

export type RuntimeBridgeHandlerMap = {
  [Method in DesktopBridgeMainInvokeMethod]: RuntimeBridgeHandler<Method>;
};

export function assertDistinctRuntimeBridgeHandlerKeys(
  groups: readonly Readonly<Record<string, unknown>>[]
): void {
  const seenKeys = new Set<string>();
  for (const group of groups) {
    for (const key of Object.keys(group)) {
      if (seenKeys.has(key)) {
        throw new Error(`Duplicate runtime bridge handler '${key}'.`);
      }
      seenKeys.add(key);
    }
  }
}
