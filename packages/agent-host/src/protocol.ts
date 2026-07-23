import {
  artifactRefSchema,
  capabilitiesSchema,
  dispatchResultSchema,
  hostEventSchema,
  hostHelloSchema,
  mailboxCommandSchema,
  serverEventSchema,
  type ArtifactRef,
  type DispatchResult,
  type HostEvent,
  type HostHello,
  type MailboxCommand,
  type NormalizedFailure,
  type ServerEvent,
  type ServerToHostCommand
} from "@planweave-ai/distributed-protocol";

export type {
  ArtifactRef,
  DispatchResult,
  HostEvent,
  HostHello,
  MailboxCommand,
  NormalizedFailure,
  ServerEvent,
  ServerToHostCommand
};

export function parseAgentHostArtifactRef(input: unknown): ArtifactRef {
  return artifactRefSchema.parse(input);
}

export function parseAgentHostCapabilities(input: unknown): string[] {
  return capabilitiesSchema.parse(input);
}

export function parseAgentHostDispatchResult(input: unknown): DispatchResult {
  return dispatchResultSchema.parse(input);
}

export function parseAgentHostEvent(input: unknown): HostEvent {
  return hostEventSchema.parse(input);
}

export function parseAgentHostMailboxCommand(input: unknown): MailboxCommand {
  return mailboxCommandSchema.parse(input);
}

export function parseAgentHostServerEvent(input: unknown): ServerEvent {
  return serverEventSchema.parse(input);
}

export function serializeAgentHostEvent(input: unknown): string {
  return JSON.stringify(parseAgentHostEvent(input));
}

export function serializeAgentHostHello(input: unknown): string {
  return JSON.stringify(hostHelloSchema.parse(input));
}
