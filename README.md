<h1 align="center">PlanWeave</h1>

<p align="center">
  PlanWeave is a file-backed loop engineering system for long-running coding agents. It turns fuzzy plans into claimable tasks, routes them through implementation and review agents, records every run, and keeps the loop recoverable.
</p>

<p align="center">
  <img src="readme/assets/planweave-readme-animation.svg" width="860" alt="PlanWeave brand motion." />
</p>

<p align="center">
  <a href="readme/README.zh-CN.md">中文 README</a>
</p>

<!-- planweave-badges:start -->
<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-0.3.0-orange?style=for-the-badge" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-yellow.svg?style=for-the-badge" />
  <img alt="language" src="https://img.shields.io/badge/language-TypeScript-3178c6?style=for-the-badge" />
  <img alt="runtime" src="https://img.shields.io/badge/runtime-Node.js-43853d?style=for-the-badge" />
  <img alt="desktop" src="https://img.shields.io/badge/desktop-Electron-47848f?style=for-the-badge" />
  <img alt="agents" src="https://img.shields.io/badge/agents-Codex%20%7C%20Claude%20Code%20%7C%20OpenCode%20%7C%20Pi%20%7C%20Grok-6f42c1?style=for-the-badge" />
</p>
<!-- planweave-badges:end -->

## Why PlanWeave

Chat is a useful place to start a plan, but it is a fragile place to run a long engineering loop.

PlanWeave turns a fuzzy goal or chat-authored plan into a task graph of nodes and block documents. Each block can be claimed by a focused agent, routed through implementation and review, and recorded as durable run artifacts. Agents get the current block plus relevant graph context, while the project keeps a recoverable history of what ran, what passed review, and what needs another loop.

That makes PlanWeave a better fit for complex engineering work: parallel implementation, staged checks, review feedback, follow-up fixes, continued execution, and progress tracking all stay inside the same local loop.

## Highlights

- **Files are nodes, documents are blocks**: the graph is not a decoration on top of chat. It is the project model.
- **Graph-friendly by default**: task flow, dependencies, review loops, and execution status are visible and editable.
- **Zero-config start**: install the CLI and agent skills, then use a few commands and skill prompts to create, run, and inspect a plan in an existing project.
- **Scoped graph context**: agents receive the current block plus relevant task graph context, and can inspect more when needed.
- **Focused responsibilities**: each claim hands one focused block to one agent, keeping context clean and avoiding unrelated plans, stale discussion, and wasted tokens.
- **Per-node and per-block agent routing**: use Codex for one block, Claude Code, OpenCode, Pi, or Grok for another, and use local review scripts where deterministic checks are enough.
- **MCP authoring for ChatGPT**: connect ChatGPT to PlanWeave through the local MCP server, a headless systemd tunnel, or the desktop secure tunnel, then ask it to create canvases, tasks, blocks, review pipelines, and dependencies.
- **Full auto-run workflow**: PlanWeave can claim blocks, run agents, collect reports, handle review feedback, and continue the task flow.
- **Review and feedback as first-class work**: review blocks can produce structured feedback that returns to implementation blocks.
- **Desktop and CLI support**: use the visual Electron canvas or drive the same runtime from the terminal.
- **Live observability**: block runs keep ordered events, logs, reports, metadata, and available monitor actions.
- **Statistics, search, and todo views**: inspect development efficiency and project state without leaving the workflow.
- **Local-first and file-backed**: plans, prompts, run records, and artifacts remain inspectable in your workspace.

## Quick Start

Use PlanWeave Desktop for visual planning and execution, or install the CLI for terminal workflows.

Install the CLI with npm:

```bash
npm install -g @planweave-ai/cli
```

Or install it with Homebrew:

```bash
brew install GaosCode/tap/planweave
```

Then run:

```bash
planweave --help
```

Install the agent skills as well:

```bash
npx skills@latest add GaosCode/PlanWeave
```

## Desktop App

PlanWeave Desktop provides a visual task canvas, task workspaces, Auto Run controls, run history, search and statistics views, and MCP tunnel settings for ChatGPT.

<p align="center">
  <img src="readme/assets/planweave-desktop-canvas.png" width="860" alt="PlanWeave desktop canvas showing an agent task graph with implementation and review blocks." />
</p>

Install a packaged build from [GitHub Releases](https://github.com/GaosCode/PlanWeave/releases). Current desktop installers are unsigned, so macOS or Windows may show a security warning. If macOS blocks the app, confirm it came from this repository and run:

```bash
xattr -dr com.apple.quarantine "/Applications/PlanWeave.app"
```

For repository layout, source setup, tests, and packaging commands, see [Development](DEVELOPMENT.md).

## Agent Execution

PlanWeave supports executor profiles, so different blocks can run through Codex, Claude Code, OpenCode, Pi, Grok, or local review commands. The runtime carries accepted results through review-feedback loops.

Each block run writes durable output under the PlanWeave workspace, including prompt, stdout, stderr, report, metadata, and monitor commands when available.

Custom package executor profiles must be trusted before use with `planweave trust executor <profile>`.

## Agent Skills

The repository includes focused agent skills under `skills/`:

- `plan-maker`: design a PlanWeave package-shaped draft from a fuzzy goal or sparse codebase context, then materialize it through draft validation/import when requested.
- `plan-importer`: create a PlanWeave package draft from strong source docs, then validate, preview, and import it through the draft import flow.
- `plan-auditor`: review an already-authored PlanWeave plan for coverage, lifecycle gaps, contract drift, weak prompts, and unverifiable completion criteria.
- `plan-coordinator`: keep a full PlanWeave execution loop moving as the main agent, dispatching implementation, review, and recovery work.
- `plan-runner`: execute one implementation block and produce a completion report.
- `plan-reviewer`: execute one review gate and produce a structured `passed` or `needs_changes` result.
- `plan-recovery`: diagnose and recover stale current refs, state/results drift, blocked/diverged work, and submit retry confusion.

Install them with the `skills` CLI:

```bash
npx skills@latest add GaosCode/PlanWeave
```

## Agent Workflow

After installing the skills, use this flow in your target project:

1. Ask your agent to create or import a plan.

```text
Use skill: plan-maker
Create a PlanWeave plan for this project from the goal below...
```

If you already have PRDs, roadmaps, issues, or architecture notes, use `plan-importer` instead. To materialize a plan, `plan-maker` writes a package-shaped draft and runs:

```bash
planweave package-draft validate --draft-root <draft> --json
planweave package-draft quality --draft-root <draft> --json
planweave package import --from <draft> --dry-run --json
planweave package import --from <draft> --apply --json
```

2. Ask the coordinator to run the plan.

```text
Use skill: plan-coordinator
Run the current PlanWeave package. Route implementation to plan-runner, review gates to plan-reviewer, and recovery work to plan-recovery.
```

3. Let the coordinator dispatch focused agents.

The coordinator should assign one concrete block at a time. Implementation agents use `plan-runner`; review agents use `plan-reviewer`; abnormal state or submit retry problems use `plan-recovery`.

4. Use the CLI for inspection when needed.

```bash
planweave status
planweave current
planweave explain <ref>
planweave graph inspect --view summary --json
planweave graph quality --json
planweave doctor
```

For simple tasks, one agent can use `plan-runner` directly. For larger plans, use `plan-coordinator` as the main agent and route subagent work to `plan-runner`, `plan-reviewer`, or `plan-recovery`.

## MCP and ChatGPT Web Planning

PlanWeave includes a local HTTP MCP server for MCP clients such as ChatGPT. Its tools inspect and author plans by initializing projects, creating canvases, adding tasks and blocks, wiring dependencies, editing prompts, configuring review pipelines, validating graph quality, and importing package drafts.

For ChatGPT in the browser, use the CLI MCP tunnel on a VPS or PlanWeave Desktop's MCP settings on a local machine. You can use ChatGPT Web as the planning partner: describe the project goal, ask it to write a package-shaped draft in a temporary draft root, dry-run validate and quality-check it, preview the import, then apply it transactionally.

Recommended headless setup for a VPS uses systemd. The MCP server stays on loopback, the OpenAI `tunnel-client` keeps an outbound connection open, and systemd manages the service lifecycle.

```bash
sudo mkdir -p /etc/planweave /srv/planweave
sudo chmod 700 /etc/planweave

planweave mcp tunnel download
planweave mcp tunnel configure --tunnel-id tunnel_xxx
planweave mcp tunnel print-systemd \
  --planweave-home /srv/planweave \
  --env-file /etc/planweave/mcp-tunnel.env
```

Put the Runtime API key in the systemd environment file, not in PlanWeave's JSON config:

```bash
PLANWEAVE_HOME=/srv/planweave
OPENAI_RUNTIME_API_KEY=...
```

Keep that file readable only by the service owner:

```bash
sudo chmod 600 /etc/planweave/mcp-tunnel.env
```

Install the printed service as `planweave-mcp-tunnel.service`, then run:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now planweave-mcp-tunnel
journalctl -u planweave-mcp-tunnel -f
```

For local desktop setup:

1. Open **Settings -> MCP Tunnel** in the desktop app.
2. Download or select the OpenAI [`tunnel-client`](https://github.com/openai/tunnel-client).
3. Enter your Tunnel ID and Runtime API key, then start the secure tunnel.
4. Add PlanWeave in ChatGPT using the Tunnel connection mode.

Once connected, ChatGPT can create, inspect, validate, and import PlanWeave plans through the MCP tools.

Source-level MCP server setup is documented in [Development](DEVELOPMENT.md).

## Auto Run

Auto Run claims ready work, invokes the selected executor, submits artifacts, continues review-feedback loops, and records each run as a session.

```bash
planweave run --once --json
planweave run --parallel --step-limit 20 --timeout 120000 --json
planweave run --scope task --task T-001 --once --json
planweave run --scope block --block T-001#B-001 --once --json
```

The executor is resolved from the block, task, and package defaults. Use `--executor <profile>` for an explicit run override and `--canvas <canvas-id>` to select a canvas.

PlanWeave Desktop provides scoped run controls, live progress, and session history. CLI users can inspect the same runtime state with:

```bash
planweave run-status --follow --json
planweave run-sessions --json
planweave run-session <session-id> --json
```

### ACP runners

PlanWeave provides explicit ACP profiles for Codex, Claude Code, OpenCode, Pi, and Grok: `codex-acp`, `claude-code-acp`, `opencode-acp`, `pi-acp`, and `grok-acp`.

Install and authenticate the selected agent, then verify and run its profile:

```bash
planweave executors test codex-acp --json
planweave run --once --executor codex-acp --timeout 120000 --json
```

ACP preflight negotiates the authentication methods advertised by the selected agent and can use credentials already configured for non-interactive authentication. If user action is required, CLI and Desktop show the next step; interactive login remains agent-owned and is not started automatically. PlanWeave does not persist agent credential values in run metadata or Desktop state.

ACP runs expose structured progress, artifacts, usage, and interaction requests through CLI and Desktop.

## Distributed Operator Guide

PlanWeave can run a **Coordinator** (`planweave-server`) that schedules remote Blocks onto independently deployed **Agent Hosts** (`planweave-agent-host`). Remote execution is **ACP-only**: the Host launches a local ACP agent profile against a configured workspace. Provider API keys, agent login state, and Git credentials stay on the Host machine. Git clone/fetch/push are Block content or Host-side environment setup, not Coordinator features.

Use HTTPS in production. Plain HTTP is **development-only** and only accepted on literal loopback (`127.0.0.1` / `::1`) when both sides set `allowInsecureDevelopment: true`.

### Install the CLIs

From this monorepo (after `pnpm install` and `pnpm -r build`):

```bash
pnpm --filter @planweave-ai/server exec planweave-server --help
pnpm --filter @planweave-ai/agent-host exec planweave-agent-host --help
```

Published package names are `@planweave-ai/server` (binary `planweave-server`) and `@planweave-ai/agent-host` (binary `planweave-agent-host`). Both require Node.js 22.5+.

### Start the Coordinator

Create an absolute-path JSON config (`server-config/v1`). Store only **SHA-256 digests** of operator bearer tokens (never the raw token in the config file).

```bash
# Produce tokenSha256 for operatorCredentials (token must be 32–256 chars: [A-Za-z0-9_-]+)
node -e "const {createHash}=require('node:crypto'); console.log(createHash('sha256').update(process.argv[1]).digest('hex'))" "$OPERATOR_TOKEN"
```

Production-shaped config (placeholders only):

```json
{
  "version": "server-config/v1",
  "bind": { "host": "0.0.0.0", "port": 7443 },
  "publicUrl": "https://coordinator.example.com:7443",
  "tls": {
    "certificatePath": "/etc/planweave/tls/fullchain.pem",
    "privateKeyPath": "/etc/planweave/tls/privkey.pem"
  },
  "dataDirectory": "/var/lib/planweave/server",
  "trustedProjects": [
    {
      "projectId": "planweave-project-example",
      "canvasId": "default",
      "projectRoot": "/srv/planweave/projects/example"
    }
  ],
  "operatorCredentials": [
    {
      "operatorId": "ops-admin",
      "tokenSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "projectIds": [],
      "serverAdmin": true
    }
  ]
}
```

Start and stop:

```bash
planweave-server serve --config /etc/planweave/server.json
# or: PLANWEAVE_SERVER_CONFIG=/etc/planweave/server.json planweave-server serve
# SIGINT / SIGTERM drains in-flight work and exits cleanly
```

On ready, the CLI prints a safe JSON summary (`status`, `publicUrl`, bind host/port, project ids). It does not print tokens or data-directory secrets.

Unauthenticated health endpoints:

```bash
curl -fsS https://coordinator.example.com:7443/healthz
curl -fsS https://coordinator.example.com:7443/readyz
curl -fsS https://coordinator.example.com:7443/version
```

`/readyz` returns HTTP 200 only when the server is ready to accept operator mutations. While migrating or reconciling it may return 503.

### TLS and development transport

| Mode | `publicUrl` | `tls` | `allowInsecureDevelopment` |
| --- | --- | --- | --- |
| Production | `https://…` origin (port must match `bind.port`) | certificate + private key absolute paths required | omit / `false` |
| Local development only | `http://127.0.0.1:<port>` | omit | `true` (bind host must be loopback) |

Host configs that talk to a development Coordinator set `coordinator.allowInsecureDevelopment: true` and use the same loopback origin. For private CAs in production, set Host `coordinator.caCertificatePath` to an absolute PEM path.

### Install and enroll an Agent Host

1. Prepare absolute paths for Host `dataDirectory` and `workspaceRoot`.
2. Under `workspaceRoot`, create relative project directories listed in `workspaces[].path` (no `..`, no absolute paths).
3. Configure ACP profiles: absolute `command`, optional `args`, and required environment **names** (values are read from the Host process environment at preflight/run time; secrets are not stored in the config file).

```json
{
  "version": "agent-host-config/v1",
  "coordinator": {
    "url": "https://coordinator.example.com:7443",
    "caCertificatePath": "/etc/planweave/tls/ca.pem"
  },
  "dataDirectory": "/var/lib/planweave/agent-host",
  "workspaceRoot": "/srv/planweave/host-workspaces",
  "host": {
    "displayName": "gpu-lab-01",
    "capacity": 2,
    "capabilities": ["acp.codex", "linux"]
  },
  "workspaces": [
    { "id": "planweave-project-example", "path": "example" }
  ],
  "agentProfiles": [
    {
      "id": "codex-acp",
      "agentId": "codex",
      "command": "/usr/local/bin/codex-acp",
      "args": [],
      "environment": [{ "name": "OPENAI_API_KEY", "required": true }]
    }
  ]
}
```

Operator commands:

```bash
planweave-agent-host preflight --config /etc/planweave/agent-host.json
# Create a one-time enrollment grant as a server admin (see Operator HTTP below), then:
planweave-agent-host enroll --config /etc/planweave/agent-host.json --code pw_enroll_...
# Re-enroll / rotate an existing local credential (clears prior active credential when safe):
planweave-agent-host enroll --config /etc/planweave/agent-host.json --code pw_enroll_... --replace
planweave-agent-host status --config /etc/planweave/agent-host.json
planweave-agent-host run --config /etc/planweave/agent-host.json
planweave-agent-host revoke --config /etc/planweave/agent-host.json
```

`preflight`, `enroll`, `status`, and `revoke` print JSON diagnostics (`credential`, `capacity`, `capabilities`, `recoverableExecutions`, optional `hostId` / `actionableError`). `run` starts the daemon until SIGINT/SIGTERM, or until a terminal transport/auth failure.

Host credentials live under the Host `dataDirectory` (for example `credentials.json`). Provider and Git credentials remain Host-local environment or agent configuration.

### Operator HTTP surface

Authenticated routes require `Authorization: Bearer <operator-token>` and TLS (or loopback development mode). Server-admin credentials can enroll and revoke hosts; project-scoped credentials may only dispatch and observe operations for their `projectIds`.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/host-enrollments` | Create enrollment grant (`expiresAt`, `credentialExpiresAt`) → `{ enrollmentCode, expiresAt }` |
| `GET` | `/api/v1/hosts` | List hosts (`cursor`, `limit`) — capacity, lastSeenAt, revokedAt |
| `GET` | `/api/v1/hosts/:hostId` | Host detail |
| `POST` | `/api/v1/hosts/:hostId/revoke` | Server-side Host credential revocation + disconnect |
| `POST` | `/api/v1/remote-operations` | Dispatch a Block (`projectId`, `canvasId`, `blockRef`, `idempotencyKey`) → operation view (HTTP 202) |
| `GET` | `/api/v1/remote-operations/:operationId` | Observe operation / attempt / runtime binding |
| `POST` | `/api/v1/remote-operations/:operationId/actions` | Lifecycle action: `cancel`, `resume_same_session`, `retry_new_attempt`, `fail`, `block` |
| `GET` | `/api/v1/remote-operations/:operationId/events` | Replay ACP events (`afterCursor`) |
| `GET` | `/api/v1/remote-operations/:operationId/interactions` | List pending interactions |
| `POST` | `/api/v1/remote-operations/:operationId/interactions/respond` | Settle an interaction |

Example: grant enrollment and list host readiness:

```bash
curl -fsS -X POST "https://coordinator.example.com:7443/api/v1/host-enrollments" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{"expiresAt":"2030-01-01T00:00:00.000Z","credentialExpiresAt":"2030-01-08T00:00:00.000Z"}'

curl -fsS "https://coordinator.example.com:7443/api/v1/hosts?limit=50" \
  -H "Authorization: Bearer $OPERATOR_TOKEN"
```

Example: dispatch and observe a Block:

```bash
curl -fsS -X POST "https://coordinator.example.com:7443/api/v1/remote-operations" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "projectId":"planweave-project-example",
    "canvasId":"default",
    "blockRef":"T-001#B-001",
    "idempotencyKey":"ops-dispatch-001"
  }'

curl -fsS "https://coordinator.example.com:7443/api/v1/remote-operations/$OPERATION_ID" \
  -H "Authorization: Bearer $OPERATOR_TOKEN"
```

Cancel / recover use `POST .../actions` with an action body that includes the live attempt identity (`actionId`, `operationId`, `dispatchId`, `executionAttemptId`, `expectedAttemptVersion`, lease fields, and `kind`). Read those fields from the latest operation observation before posting. Supported `kind` values:

- `cancel` — request cooperative cancellation of an active attempt
- `resume_same_session` — resume after a fenced interruption with recovery evidence
- `retry_new_attempt` — start a new dispatch/attempt after non-resumable interruption
- `fail` / `block` — terminal operator outcomes when the attempt is in an action-required or interrupted state

Idempotent re-dispatch uses the same `idempotencyKey` for the same project/canvas/block.

### Rotate or revoke Host credentials

1. **Server revoke**: `POST /api/v1/hosts/:hostId/revoke` (server admin). The Host is disconnected; existing local credential material is not automatically deleted on the Host.
2. **Local Host revoke**: `planweave-agent-host revoke --config …` marks the local credential revoked so `run` will not use it.
3. **Rotate**: create a new enrollment grant, then `planweave-agent-host enroll --config … --code … --replace` on the Host (only when durable execution state allows safe replacement).

### Common failures

| Symptom | Likely cause | What to check |
| --- | --- | --- |
| CLI `server_cli_usage` / `agent_host_cli_usage` (exit 2) | Wrong argv | `serve --config <abs>`; Host commands need `--config`; `enroll` needs `--code` |
| `server_tls_configuration_required` | Production config without TLS | Provide `tls` + `https` `publicUrl`, or use loopback development mode |
| `server_insecure_development_requires_literal_loopback` | Insecure mode off loopback | Bind and public URL must be `127.0.0.1` / `::1` |
| `/readyz` → 503 | Not ready / draining / reconciling | Wait for startup; do not dispatch during drain |
| Operator HTTP 426 `operator_insecure_transport` | HTTP without development mode | Use TLS or enable loopback insecure development on both sides |
| Operator HTTP 401 | Bad or missing bearer token | Token must match a configured `tokenSha256` |
| Operator HTTP 403 | Scope / admin required | Enrollment and host revoke need `serverAdmin`; project dispatch needs project scope |
| Host `credential: missing` | Not enrolled | Run `enroll` with a fresh grant |
| Host `credential: revoked` / `expired` | Local or server lifecycle | Re-enroll with `--replace` after a new grant |
| Host `agent_host_auth_failed` on `run` | Server revoked or token mismatch | Revoke locally, re-enroll |
| Host `agent_host_profile_environment_missing:…` | Required env unset | Export provider keys on the Host before preflight/run |
| Host `agent_host_workspace_not_configured` | Workspace id mismatch | `workspaces[].id` must match the PlanWeave project id the Coordinator trusts |
| Dispatch never schedules | No online Host / capability mismatch | Confirm Host `lastSeenAt`, `capacity`, and overlapping `capabilities` |
| Cancel / resume 409 | Stale attempt version or wrong lease | Re-fetch operation view; use current `expectedAttemptVersion` and lease ids |

Project package state on the Coordinator host remains the source of truth for Block content. After remote runs, inspect the same package with the ordinary `planweave status` / `planweave explain <ref>` / `planweave doctor` commands; remote ownership appears in those JSON projections without Host secrets.

### Automated walkthrough coverage

Repository integration test `packages/server/src/__tests__/operatorWalkthrough.test.ts` exercises a clean temporary loop: start Coordinator, preflight/enroll Host, observe host capacity, create/observe a remote operation, stop and restart Host and Coordinator, revoke credentials, and shut down. It does not depend on README content. Full ACP execution success, interactive permission settlement, and production TLS certificate issuance remain manual or covered by other package tests.

## Future Direction

PlanWeave will continue to expand in three directions:

- **Auto Run**: improve execution control, recovery, and long-running reliability.
- **Collaborative planning**: let teams edit and refine the same task board together.
- **Cross-host execution**: harden scheduling, capacity, and recovery for multi-Host fleets.

## Development

Contributor setup, repository layout, test commands, and local packaging notes live in [DEVELOPMENT.md](DEVELOPMENT.md).

## License

MIT. See [LICENSE](LICENSE).
