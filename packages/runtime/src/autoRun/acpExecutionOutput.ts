import type { SessionNotification } from "@agentclientprotocol/sdk";

export function assistantTextChunk(notification: SessionNotification): string | null {
  const update = notification.update;
  if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") return null;
  return update.content.text;
}
