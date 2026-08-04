# PlanWeave Agent Host

`@planweave-ai/agent-host` runs an ACP coding agent on a Windows or Linux machine and exposes it to a PlanWeave Server as a remote Agent Endpoint. Desktop users select that endpoint from the same Agent selector used for local agents; they do not choose a Host separately.

## Requirements

- Node.js 22.5 or newer
- pnpm when running the pre-release Host from a source checkout
- A Windows user account or Linux user account that will own the Host process and its private files
- The selected ACP agent installed and authenticated on that same account (for example, Codex for `codex-acp`)
- One reachable PlanWeave Server Origin

Tailscale HTTPS and direct HTTPS are supported connection topologies; either topology supplies the single Server Origin shared by Desktop and the Host. LAN HTTP is unencrypted and is accepted only when the enrollment handoff explicitly enables the insecure development topology.

## Install

This source tree does not assert that `@planweave-ai/agent-host` is already available from the npm registry. For pre-release testing from a source checkout, install workspace dependencies and build the Host:

```bash
pnpm install
pnpm --dir packages/agent-host build
node packages/agent-host/dist/bin.js --help
```

When using a source checkout, replace `planweave-agent-host` in the commands below with `node <absolute-repository-path>/packages/agent-host/dist/bin.js`. After an npm registry release is available, `npm install -g @planweave-ai/agent-host` provides the shorter global command shown in this guide.

Install and sign in to the selected ACP agent before enrolling the Host. PlanWeave does not start the agent's interactive login flow for you.

## Enroll from Desktop

1. In PlanWeave Desktop, open **Settings -> Agent Hosts**.
2. Select a server-admin profile with an available operator credential.
3. Under **Connect an Agent Host**, create and copy the one-time enrollment command.
4. Run the complete copied command on the Host machine:

```bash
planweave-agent-host enroll <handoff>
```

The handoff is single-use and expires. The command writes Host-private configuration and credentials, attempts to install the platform background process, and prints one JSON result. Read `configPath` from that result and use the returned absolute path in later commands; do not guess or copy a path from another Host.

Enrollment exposes no Agent by default. List the supported profiles, expose the installed Agent, and run preflight:

```bash
planweave-agent-host agents list --config <absolute-config-path>
planweave-agent-host agents expose codex-acp --config <absolute-config-path>
planweave-agent-host preflight --config <absolute-config-path>
```

The Host currently recognizes the built-in ACP profile IDs `codex-acp`, `claude-code-acp`, `opencode-acp`, `pi-acp`, and `grok-acp`. `agents list` reports which profiles can be resolved on that machine. Expose only profiles whose agent is installed and authenticated.

After the Host reports readiness, every exposed remote Agent Endpoint enters Desktop's unified Agent selector automatically. There is no separate Host choice for a run.

### Enrollment options

The portable Desktop handoff supports these options:

```text
planweave-agent-host enroll <handoff> [--workspace-root <absolute-path>] [--ca-certificate <absolute-path>] [--no-background]
```

Use `--workspace-root` to override the Host-local workspace root, `--ca-certificate` when the handoff requires a configured CA, or `--no-background` to enroll without installing the platform background process. All paths must be absolute on the Host machine.

## Non-interactive enrollment

For operator-managed automation with an existing absolute config path and an enrollment or setup code:

```text
planweave-agent-host enroll --config <absolute-path> --code <enrollment-or-setup-code> [--replace]
```

`--replace` replaces an existing enrollment only when the Host's durable execution state allows it. To add the Codex preset to an already prepared config before enrollment, use:

```bash
planweave-agent-host config-init --config <absolute-path> --preset codex-acp
```

The portable Desktop handoff is the recommended setup path because it carries the validated endpoint and workspace identity together.

## Agent exposure

Exposure changes which Host-local ACP profiles PlanWeave Server may dispatch to. These commands never perform an agent login:

```text
planweave-agent-host agents list --config <absolute-path>
planweave-agent-host agents expose <supported-profile> --config <absolute-path>
planweave-agent-host agents hide <supported-profile> --config <absolute-path>
```

If the Host is running in the installed background mode, an exposure change restarts it when possible; otherwise the JSON result reports that a restart is required.

## Background lifecycle

Portable enrollment installs and starts background mode by default. The lifecycle commands are:

```text
planweave-agent-host service install --config <absolute-path>
planweave-agent-host service uninstall --config <absolute-path>
planweave-agent-host service status --config <absolute-path>
planweave-agent-host service restart --config <absolute-path>
planweave-agent-host service logs --config <absolute-path>
```

You can also run the Host in the foreground:

```bash
planweave-agent-host run --config <absolute-path>
```

Other operational checks are available without starting the foreground process:

```bash
planweave-agent-host preflight --config <absolute-path>
planweave-agent-host status --config <absolute-path>
planweave-agent-host revoke --config <absolute-path>
```

### Linux

Background mode installs a user-systemd unit for the current user and manages it with `systemctl --user`. It is not a system-wide root service. If the Host must continue without an interactive login session, an administrator may need to enable linger for the owning user:

```bash
sudo loginctl enable-linger <user>
```

`service logs` returns the matching `journalctl --user` command for the unit.

### Windows

Background mode creates a current-user `ONLOGON` Scheduled Task with limited privileges and starts it immediately. This is not a Windows SCM service: the task runs after that user signs in.

`service logs` returns the task name and the `Microsoft-Windows-TaskScheduler/Operational` diagnostic log. The Scheduled Task integration does not capture Host stdout, so this command must not be treated as a Host output log.

## Security boundary

- Treat the enrollment handoff as a short-lived secret: use it once, before it expires, and never put it in project files, chat, shell transcripts, or logs.
- ACP credentials, resolved ACP command paths, and environment-variable values stay in Host-private storage and are not uploaded to PlanWeave Server.
- The Host credential token is persisted in plaintext only in Host-private storage. It is sent to the configured Server during enrollment and as Bearer authentication for Host WebSocket and HTTP requests; the Server persists its one-way hash rather than the plaintext token.
- The Server receives the Host identity, liveness, capacity, capabilities, workspace readiness, and exposed Agent readiness needed for dispatch; it does not receive Host-local secret values or command paths.
- Keep the generated config, data directory, and credential files private to the operating-system user that runs the Host.
- Prefer Tailscale HTTPS or direct HTTPS. Use LAN HTTP only as an explicit insecure development mode on a trusted private network.
