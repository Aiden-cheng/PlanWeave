import type { AcpConversationTurnConnectionOptions } from "../autoRun/acpConversationTurn.js";

export function conversationHostCleanup(
  options: AcpConversationTurnConnectionOptions
): (() => Promise<void>) | undefined {
  return options.cleanupExitedProcessTree;
}
