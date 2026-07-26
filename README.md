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

PlanWeave can run a **Coordinator** (`planweave-server`) that schedules remote Blocks onto independently deployed **Agent Hosts** (`planweave-agent-host`). The same Coordinator also hosts human project membership, assignment metadata, scoped comments, and remote-run observation for Desktop collaboration clients.

### Product boundaries

| Concern | PlanWeave does | PlanWeave does **not** |
| --- | --- | --- |
| Work coordination | Coordinates Tasks/Blocks in a Plan Package; records claim/run/review state | Own Git branches, worktrees, merge, push policy, or repository layout |
| Remote execution | Dispatches Blocks to enrolled Hosts over the public Agent Host protocol | Provide a remote CLI-executor fallback when ACP is unavailable |
| Secrets | Accepts Host enrollment tokens and operator bearer digests; mints human device tokens once | Store provider API keys, Agent login state, or Git credentials on the Coordinator |
| Workspace / profiles | Trusts configured project roots and Host workspace/profile mappings | Sync Host workspace trees or ACP profile binaries from the Coordinator |
| Transport | **HTTPS** (HTTP APIs) and **WSS** (Agent Host connect path `/agent-hosts/:hostId/connect`) in production | Accept non-loopback plain HTTP/WS without explicit development mode |
| Assignment vs dispatch | **Assignment** is coordination metadata (who/which Host *should* own work); **dispatch** is an explicit remote-run start | Treat assignment write as a run start, or treat Runtime claim as assignment authority |
| Human discussion | Scoped human comments/activity on Task/Block work items | Mix human comments into Agent mailbox, ACP event streams, or Runtime claim/submit |
| Interrupted work | Requires explicit lifecycle actions (`resume_same_session`, `retry_new_attempt`, `cancel`, `fail`, `block`) | Silently re-run interrupted Blocks after restart, reconnect, or rollback |

Git clone/fetch/push remain Block content or Host-side environment preparation. PlanWeave never owns branch checkout, worktree creation, or merge decisions for you.

Use HTTPS/WSS in production. Plain HTTP/WS is **development-only** and only accepted on literal loopback (`127.0.0.1` / `::1`) when both sides set `allowInsecureDevelopment: true` (Host coordinator URL may use `http://` or `ws://` only in that mode).

### Install the CLIs

From this monorepo (after `pnpm install` and `pnpm -r build`), invoke the public package bin entries directly:

```bash
node packages/server/dist/bin.js --help
node packages/agent-host/dist/bin.js --help
```

Those paths are the `planweave-server` and `planweave-agent-host` bin targets declared in each package's `package.json`. After a published install, the same entry points are on `PATH` as:

```bash
planweave-server --help
planweave-agent-host --help
```

Published package names are `@planweave-ai/server` (binary `planweave-server`) and `@planweave-ai/agent-host` (binary `planweave-agent-host`). Both require Node.js 22.5+ (they use the built-in `node:sqlite` module; no `better-sqlite3` native binding).

Pack the distributed publish graph and run a clean temporary install/start smoke:

```bash
pnpm pack:distributed
pnpm check:distributed-package-install
```

**Supported platform claims** require produced artifacts plus clean-install, packaged-start, and relevant multi-process/live gate evidence on that OS and architecture. TypeScript compilation or monorepo unit tests alone are not sufficient evidence of platform support.

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

Optional `limits` keys (all optional; defaults shown):

| Key | Default | Meaning |
| --- | --- | --- |
| `busyTimeoutMs` | `5000` | SQLite busy timeout |
| `leaseDurationMs` | `30000` | Host lease duration |
| `hostOfflineAfterMs` | `90000` | Offline threshold after last heartbeat (must be `>` heartbeat) |
| `heartbeatIntervalMs` | `15000` | Expected Host heartbeat interval (must be `<` lease and offline) |
| `maxArtifactBytes` | `104857600` (100 MiB) | Max single remote artifact |
| `maxWebSocketPayloadBytes` | `262144` | Max Agent Host WebSocket frame |
| `eventRetentionMaxEvents` | `100000` | Max retained remote ACP events per retention policy |
| `eventRetentionMaxBytes` | `33554432` (32 MiB) | Max retained remote ACP event bytes |
| `shutdownTimeoutMs` | `5000` | Drain timeout on SIGINT/SIGTERM |

The SQLite database path is always `<dataDirectory>/planweave-server.sqlite` (not configurable separately).

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

| Mode | `publicUrl` / Host `coordinator.url` | `tls` | `allowInsecureDevelopment` |
| --- | --- | --- | --- |
| Production | `https://…` origin (port must match `bind.port`); Host upgrades to **WSS** for `/agent-hosts/:hostId/connect` | certificate + private key absolute paths required | omit / `false` |
| Local development only | `http://127.0.0.1:<port>` (or Host `ws://`/`http://` loopback) | omit | `true` (bind host must be loopback) |

Host configs that talk to a development Coordinator set `coordinator.allowInsecureDevelopment: true` and use the same loopback origin. For private CAs in production, set Host `coordinator.caCertificatePath` to an absolute PEM path. Agent Host mailbox and ACP control traffic use the Host WebSocket session; human observer traffic (Desktop) is a separate contract and must not be confused with Host mailbox sequences.

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

Host credentials live under the Host `dataDirectory` (for example `credentials.json`). Provider and Git credentials remain Host-local environment or agent configuration. Workspace paths under `workspaceRoot` and ACP `agentProfiles` (command path, args, required environment **names**) stay on the Host config — the Coordinator never receives those secrets or profile binaries.

Supported Host-local ACP profile ids (Runtime registry): `codex-acp`, `claude-code-acp`, `opencode-acp`, `grok-acp`, `pi-acp`. Remote dispatch fails closed when ACP protocol negotiation fails; there is **no** remote CLI fallback.

### Human collaboration (identity, assignment, comments)

Human collaboration is project-scoped and separate from Host enrollment, operator tokens, and Agent Host mailbox traffic.

**Roles:** only `owner` and `member`. Invitations always grant `member` (never owner). Last remaining owner cannot be removed or demoted.

**Credentials (never interchangeable):**

| Prefix / shape | Subject | Used for |
| --- | --- | --- |
| Operator bearer (config stores SHA-256 only) | operator | Host enroll/revoke, operator remote-operations |
| `pw_enroll_…` | one-time Host enrollment grant | Host `enroll` only |
| `pw_host_…` | enrolled Agent Host | Host WSS connect + Host HTTP |
| `pw_hdev_…` | human device | Human collaboration HTTPS |
| `pw_inv_…` | one-shot invitation | Join project as `member` only |

Host-shaped tokens return **401** on human routes. Device tokens are returned once at bootstrap/join; store them in OS-backed secure storage (Desktop uses main-process vault / `safeStorage`), not in package files, renderer `localStorage`, or Coordinator config.

#### Owner bootstrap and membership HTTP

First owner bootstrap is a **loopback local-admin** boundary (not a network bearer). Production still requires TLS for non-bootstrap human routes; bootstrap itself only accepts loopback clients.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/v1/projects/:projectId/human/bootstrap` | loopback local-admin | Mint first project owner + device token handoff |
| `POST` | `/api/v1/projects/:projectId/human/invitations` | owner `pw_hdev_…` | Create invitation (TTL clamped server-side) |
| `GET` | `/api/v1/projects/:projectId/human/invitations` | owner | List invitations |
| `POST` | `/api/v1/projects/:projectId/human/invitations/:invitationId/revoke` | owner | Revoke invitation |
| `POST` | `/api/v1/projects/:projectId/human/invitations/consume` | invitation body | Join as `member` + device token handoff |
| `GET` | `/api/v1/projects/:projectId/human/members` | member/owner | List members |
| `POST` | `/api/v1/projects/:projectId/human/members/:humanPrincipalId/remove` | self or owner | Remove membership (last-owner protected) |
| `POST` | `/api/v1/projects/:projectId/human/members/:humanPrincipalId/promote` | owner | Promote to owner |
| `POST` | `/api/v1/projects/:projectId/human/members/:humanPrincipalId/demote` | owner | Demote owner (last-owner protected) |
| `GET` | `/api/v1/projects/:projectId/human/devices` | member (`scope=own`) / owner (`scope=project`) | List devices |
| `POST` | `/api/v1/projects/:projectId/human/devices/:deviceCredentialId/revoke` | own device or owner for member device | Soft-revoke device |

Sanitized bootstrap example (loopback only; placeholders):

```bash
curl -fsS -X POST "https://127.0.0.1:7443/api/v1/projects/planweave-project-example/human/bootstrap" \
  -H "content-type: application/json" \
  -d '{"displayName":"Ada","deviceLabel":"laptop"}'
# Response may include deviceToken exactly once — copy into a secure vault; never commit it.
```

Invitation consume (network path; token is one-shot):

```bash
curl -fsS -X POST "https://coordinator.example.com:7443/api/v1/projects/planweave-project-example/human/invitations/consume" \
  -H "content-type: application/json" \
  -d '{"invitationToken":"pw_inv_...","displayName":"Grace","deviceLabel":"studio"}'
```

#### Assignment vs dispatch

Assignment targets (coordination metadata only):

| Target | Task | Block | Meaning |
| --- | --- | --- | --- |
| `unassigned` | yes | yes | No human/Host owner |
| `human` + principal id | yes | yes | Human coordination owner (active membership required) |
| `exact_host` + host id | **no** | yes | Pin a specific enrolled Host at dispatch |
| `automatic_host` | **no** | yes | Host selected at dispatch from package `requiredCapabilities` |

Updating assignment **never** claims a Block, never starts a remote run, and never mutates the Plan Package. Dispatch is a separate explicit action (`POST /api/v1/remote-operations` for operators, or Desktop remote-run control for project members). At dispatch begin the Coordinator snapshots Host selection; later reassignment does not rewrite an in-flight selection fingerprint.

#### Comments, attachments, and activity

- Human comments annotate a **Task or Block** work item (Markdown body). They are **not** Agent chat, Runtime claim/submit traffic, Host mailbox messages, or ACP token streams.
- Comment attachments use a separate blob root and ACL (`/api/v1/projects/:projectId/attachments/*`) from remote-run artifact grants.
- Activity is an append-only projection of membership, assignment, comment, and remote-run facts for members — not a delivery ACK channel for Host mailbox.

Attachment HTTP (human device bearer):

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/projects/:projectId/attachments/pending` | Stage pending upload |
| `PUT` | `/api/v1/projects/:projectId/attachments/pending/:pendingUploadId` | Upload bytes |
| `POST` | `/api/v1/projects/:projectId/attachments/pending/:pendingUploadId/finalize` | Finalize digest |
| `GET` | `/api/v1/projects/:projectId/attachments/by-digest/:sha256` | Download by digest (membership ACL) |
| `GET` | `/api/v1/projects/:projectId/attachments/comments/:commentId/:sha256` | Download bound comment attachment |
| `POST` | `/api/v1/projects/:projectId/attachments/cleanup` | Owner cleanup of expired pending uploads |

Allowed attachment media types: `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `application/pdf`, `text/plain`, `text/markdown`. Max attachment size: **8 MiB**. Max attachments per comment: **8**.

#### Desktop collaboration surfaces

PlanWeave Desktop connects to a Coordinator with a non-secret connection profile (`serverBaseUrl` origin + `projectId`; HTTPS required unless loopback insecure mode). Device credentials stay in the main-process vault. Renderer code never sees bearer tokens and never opens raw sockets.

Typical UI surfaces (domain semantics and Desktop client contracts):

- **People**: members, invitations (owner), devices, Host presence/capacity (view-only for Hosts)
- **Assignee picker**: Task/Block assignment chips; Host targets only on Blocks
- **Comments / Activity**: scoped to the selected Task/Block; distinct from Task Workspace Agent conversation
- **Remote run panel**: explicit dispatch / observe / interaction / resume / retry / cancel — coexists with local Auto Run but does not merge status machines; local unfinished Auto Run blocks remote dispatch on the same Block

**Wire availability:** Server public HTTP for human **identity** and **comment attachments** is documented above. Operator remote-operations under `/api/v1/remote-operations*` use the **operator** bearer. Desktop client/contracts for assignment, comment/activity updates, human observer WSS (`/api/v1/projects/:projectId/human/observe`), and human-auth remote-operations do not by themselves establish a supported Server transport. Do not mix Host mailbox traffic into human comments as an operator workaround.

### Opt-in real ACP compatibility smoke

PlanWeave can exercise one **Host-local ACP agent** through the public ACP interface (not the CLI runner) to confirm adapter compatibility. This path is **opt-in** so ordinary CI never starts a real agent or needs provider credentials.

Supported Host-local profile ids (from the Runtime registry): `codex-acp`, `claude-code-acp`, `opencode-acp`, `grok-acp`, `pi-acp`. Version policy follows the Runtime ACP SDK authority (`protocolVersion` / verified adapter metadata); smoke asserts protocol/contract outcomes, not provider-specific reply text.

```bash
# List supported profiles (no agent launch)
planweave-agent-host real-acp-smoke --list-profiles

# Soft gate: missing binary/login → skipped evidence, exit 0
PLANWEAVE_REAL_ACP=1 planweave-agent-host real-acp-smoke --evidence /tmp/real-acp.json

# Hard gate: missing binary/login → failed evidence, exit 1
PLANWEAVE_REAL_ACP_REQUIRE=1 planweave-agent-host real-acp-smoke --require --profile codex-acp

# Optional monorepo helper (uses built Host bin or tsx)
PLANWEAVE_REAL_ACP=1 node scripts/real-acp-host-smoke.mjs --list-profiles
```

Environment:

| Variable | Meaning |
| --- | --- |
| `PLANWEAVE_REAL_ACP=1` | Soft gate: enable smoke; preconditions skip |
| `PLANWEAVE_REAL_ACP_REQUIRE=1` | Hard gate: preconditions fail |
| `PLANWEAVE_REAL_ACP_PROFILE=<id>` | Pin a Host-local profile id |

Setup stays secret-free in docs and evidence: preflight records executable path, non-secret agent version strings, protocol/SDK versions, and capability names only. Do not put API keys or login tokens into PlanWeave config; agent auth remains Host-local (agent login state / provider env on the Host machine). Invoking `real-acp-smoke` never falls back to a CLI executor if ACP startup or capability negotiation fails.

### Opt-in authenticated VPS / TLS end-to-end

PlanWeave can exercise the **Coordinator + Agent Host** install, certificate-verified transport, one-time enrollment, bounded fixture dispatch, event cursor replay after a network interrupt, and cleanup as an **opt-in** scenario. Ordinary CI never starts this path.

There are two clearly labeled environment classes:

| `environmentClass` | Meaning |
| --- | --- |
| `local-tls-fixture` | Disposable **loopback** Server + Host with ephemeral self-signed TLS (OpenSSL). Exercises the same enroll / dispatch / replay / revoke contracts. **Not** a production VPS claim. |
| `remote-vps` | Operator-provided disposable VPS. Connection details come **only** from an absolute config path outside the repo plus env-held tokens. Never hardcode hostnames, SSH, or secrets in the repository. |

```bash
# Soft gate: missing openssl/bins/remote config → skipped evidence, exit 0
PLANWEAVE_VPS_E2E=1 planweave-server vps-e2e --evidence /tmp/vps-e2e.json

# Hard gate
PLANWEAVE_VPS_E2E_REQUIRE=1 planweave-server vps-e2e --require --profile local-tls-fixture

# Remote VPS (config + token live outside the repo)
export PLANWEAVE_VPS_E2E_CONFIG=/absolute/path/outside-repo/vps-e2e.json
export PLANWEAVE_VPS_OPERATOR_TOKEN=...   # never commit
PLANWEAVE_VPS_E2E=1 planweave-server vps-e2e --profile remote-vps --evidence /tmp/vps-e2e.json

# Monorepo helper (uses built Server bin or tsx)
PLANWEAVE_VPS_E2E=1 node scripts/vps-authenticated-e2e.mjs --profile local-tls-fixture
```

Environment:

| Variable | Meaning |
| --- | --- |
| `PLANWEAVE_VPS_E2E=1` | Soft gate: enable e2e; missing preconditions skip |
| `PLANWEAVE_VPS_E2E_REQUIRE=1` | Hard gate: missing preconditions fail |
| `PLANWEAVE_VPS_E2E_PROFILE` | `local-tls-fixture` (default) or `remote-vps` |
| `PLANWEAVE_VPS_E2E_CONFIG` | Absolute path to remote config JSON (remote-vps only) |
| `PLANWEAVE_VPS_OPERATOR_TOKEN` | Default env name referenced by remote config for the operator bearer token |

Remote config schema (`planweave.vps-e2e-config/v1`) fields: `coordinatorUrl` (https origin), `operatorTokenEnv` (env **name**, not the token), optional `caCertificatePath`, `hostConfigPath`, `projectId`, optional `canvasId` / `blockRef` / `evidencePath`. Evidence JSON is redacted: digests and identity ids only — no endpoints, tokens, PEM, enrollment codes, or full logs.

For Host-local real agent compatibility on the same machine, reuse the [opt-in real ACP smoke](#opt-in-real-acp-compatibility-smoke) gates (`PLANWEAVE_REAL_ACP`). The VPS e2e default fixture uses the mock ACP process so CI-adjacent local runs do not need provider login.

### Live release gate and rollback checks

One release-facing command distinguishes three tiers. **A skipped live test is never a pass** for supported-version or pre-release readiness. Evidence may store only sanitized summaries and digests — never infrastructure secrets, endpoints, tokens, PEM material, or provider credentials.

| Tier | Requirement | Command / evidence |
| --- | --- | --- |
| Deterministic multi-process suite | **Required CI** | `realProcess*.test.ts` (mock ACP, no secrets) |
| Local real ACP compatibility | **Required before supported-version release** | `planweave-agent-host real-acp-smoke` hard gate evidence |
| Remote authenticated VPS | **Required pre-release evidence** | `planweave-server vps-e2e --profile remote-vps` hard gate evidence (`environmentClass=remote-vps` only) |

```bash
# Print the checklist (tiers, rollback constraints, ownership)
planweave-server release-gate --checklist

# CI tier only (runs deterministic multi-process suite)
planweave-server release-gate --run-deterministic --report /tmp/release-gate.json

# Evaluate sanitized evidence for a full pre-release verdict
planweave-server release-gate \
  --deterministic-evidence /tmp/det.json \
  --real-acp-evidence /tmp/real-acp.json \
  --vps-evidence /tmp/vps-e2e.json \
  --report /tmp/release-gate.json

# Monorepo helper
node scripts/planweave-release-gate.mjs --checklist
```

**Compatibility bounds** (enforced at the gate and before dispatch):

- Wire protocol: sole supported `agentHostProtocolVersion` (currently `1`); incompatible protocol versions fail closed.
- Server / Agent Host / `distributed-protocol` package **majors must match** for a supported matrix.
- Supported ACP Agents must negotiate the Host ACP SDK protocol version; incompatible ACP protocol majors fail closed with **no CLI fallback**.
- Graceful package downgrade is **same-major only** after state backup.

**Rollback constraints** (operator must confirm; gate documents them):

- Backup Server and Host `dataDirectory` before upgrade; restore backups on rollback.
- Do **not** reset databases to “start clean”.
- Do **not** silently re-run interrupted Blocks; use explicit lifecycle actions only (`resume_same_session`, `retry_new_attempt`, `cancel`, `fail`, `block`).
- Rotate Host credentials with `enroll --replace` and revoke prior grants/hosts.
- Clean up disposable harness state and revoke one-time enrollment materials after live evidence collection.

**Evidence rules:** live evidence expires after 14 days based on producer `generatedAt` only (file mtime is ignored). Operators own disposable VPS access and Host-local provider login; CI owns only the deterministic suite. Gate inputs are evidence paths + package versions; outputs are a JSON report with tier status, digests, compatibility checks, rollback checklist, and `releaseReady.{ci,supportedVersionRelease,preRelease}`.

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
- **Collaborative planning**: deepen multi-user plan authoring on the shared task board (beyond today’s membership, assignment, comments, and remote-run observation).
- **Cross-host execution**: harden scheduling, capacity, and recovery for multi-Host fleets.

## Development

Contributor setup, repository layout, test commands, and local packaging notes live in [DEVELOPMENT.md](DEVELOPMENT.md).

## License

MIT. See [LICENSE](LICENSE).
