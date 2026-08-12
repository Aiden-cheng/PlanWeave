# PlanWeave Agent Host

`@planweave-ai/agent-host` exposes an installed ACP Agent to PlanWeave as a remote Agent Endpoint.

## Requirements

- Node.js 22.13 or newer
- An installed and authenticated ACP Agent
- A reachable PlanWeave Server

## Install

Agent Host is included in the PlanWeave CLI:

```bash
npm install -g @planweave-ai/cli
planweave agent-host --help
```

## Enroll

1. In Desktop, open **Settings → Connections & Devices → My devices**.
2. Select **Add a remote device**, choose a credential lifetime, and copy the enrollment command.
3. Run the command on the target device:

```bash
planweave agent-host enroll <handoff>
```

Use the `configPath` returned by enrollment to expose an Agent and run preflight:

```bash
planweave agent-host agents list --config <absolute-config-path>
planweave agent-host agents expose codex-acp --config <absolute-config-path>
planweave agent-host preflight --config <absolute-config-path>
```

Supported profiles are `codex-acp`, `claude-code-acp`, `opencode-acp`, `pi-acp`, and `grok-acp`.

## Operate

```bash
planweave agent-host agents list --config <absolute-config-path>
planweave agent-host agents expose <profile> --config <absolute-config-path>
planweave agent-host agents hide <profile> --config <absolute-config-path>

planweave agent-host service status --config <absolute-config-path>
planweave agent-host service restart --config <absolute-config-path>
planweave agent-host service logs --config <absolute-config-path>

planweave agent-host status --config <absolute-config-path>
planweave agent-host run --config <absolute-config-path>
planweave agent-host revoke --config <absolute-config-path>
```

Enrollment starts background mode by default. Use `run` for foreground operation.

## Credentials

Enrollment supports 30, 90, 180, or 365-day credentials. Agent Host renews them automatically; a Server administrator can also request renewal from the device list.
