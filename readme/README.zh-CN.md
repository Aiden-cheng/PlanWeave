<h1 align="center">PlanWeave</h1>

<p align="center">
  PlanWeave 是一个文件驱动的 loop engineering 系统，面向长期运行的 Coding Agent。它把模糊计划转化为可领取任务，把任务交给实现和评审 Agent，记录每次运行，并让整个循环可恢复。
</p>
<p align="center">
  <img src="assets/planweave-readme-animation.svg" width="860" alt="PlanWeave 品牌动效。" />
</p>

<p align="center">
  <a href="../README.md">English README</a>
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


## PlanWeave 是什么

Chat 很适合发起计划，但不适合作为长期工程循环的唯一载体。

PlanWeave 可以把模糊目标或通过 Chat 生成的计划落到任务图里：任务是节点，执行步骤、检查、评审和反馈都是块。每个 block 都可以被专门的 Agent 领取，经过实现和评审，再把运行记录保存成可追踪产物。Agent 执行时拿到当前 block 和相关图上下文，项目本身则保留什么运行过、什么通过评审、什么需要继续循环的可恢复历史。

这让 PlanWeave 很适合复杂工程任务：并行实现、阶段检查、Review 出反馈、自动修复、继续执行和效率统计，都可以沉淀在同一个本地工程循环里。

## 项目优势

- **文件即节点，文档即块**：任务图不是展示层，而是项目结构本身。
- **图友好**：依赖、执行顺序、Review/Feedback 循环和状态变化都可以直接在图上观察和编辑。
- **零配置上手**：安装 CLI 和 agent skills 后，只需几个命令和 skill prompt，就能在现有项目里创建、执行和检查计划。
- **有边界的图上下文**：Agent 执行时拿到当前 block 和相关任务图上下文，需要时可以继续查看更多信息。
- **职责聚焦**：每次 claim 都把一个聚焦 block 交给一个专门的 Agent，减少无关计划、陈旧讨论和额外 token 对上下文的污染。
- **不同节点和块可指定不同 Agent**：实现块可以用 Codex，也可以把某些块交给 Claude Code、OpenCode、Pi 或 Grok，确定性检查可以交给本地命令。
- **通过 MCP 让 ChatGPT 生成计划**：把 ChatGPT 连接到 PlanWeave 本机 MCP server、headless systemd tunnel 或桌面端 secure tunnel 后，可以让它创建画布、任务、Blocks、Review Pipeline 和依赖关系。
- **全自动一站式完成任务流**：从 claim block、执行、记录报告、Review、生成反馈到继续修复，形成闭环。
- **Review 和反馈是一等公民**：Review block 可以产出结构化反馈，再回到实现 block 自动修复。
- **桌面端和 CLI 均支持**：可以用 Electron 图板操作，也可以用终端驱动同一个 runtime。
- **统计视图和搜索能力**：方便观察开发效率、运行历史、任务状态和项目 Todo。
- **本地优先、文件可审计**：prompt、运行记录、报告、metadata 和产物都留在本地工作区，便于检查、回滚和提交。
- **运行过程可监控**：每个 block run 会保留有序事件、日志、report、metadata 和可用的监控操作。

## 快速开始

使用 PlanWeave Desktop 进行可视化规划和执行，或安装 CLI 使用终端工作流。

用 npm 安装 CLI：

```bash
npm install -g @planweave-ai/cli
```

也可以用 Homebrew 安装：

```bash
brew install GaosCode/tap/planweave
```

然后运行：

```bash
planweave --help
```

同时安装 agent skills：

```bash
npx skills@latest add GaosCode/PlanWeave
```

## 桌面应用

PlanWeave Desktop 提供可视化任务画布、任务工作区、Auto Run 控制、运行历史、搜索与统计视图，以及供 ChatGPT 使用的 MCP tunnel 设置。

<p align="center">
  <img src="assets/planweave-desktop-canvas.png" width="860" alt="PlanWeave 桌面端任务画布，展示 Agent 任务图、实现块和评审块。" />
</p>

可以直接安装 [GitHub Releases](https://github.com/GaosCode/PlanWeave/releases) 里的安装包。当前桌面安装包未签名，macOS 或 Windows 可能显示安全警告。如果 macOS 阻止启动，请确认安装包来自本仓库，然后运行：

```bash
xattr -dr com.apple.quarantine "/Applications/PlanWeave.app"
```

仓库结构、源码开发、测试和本地打包命令见 [Development](../DEVELOPMENT.md)。

## Agent 执行方式

PlanWeave 支持 executor profile，因此同一张任务图里的不同 block 可以分别使用 Codex、Claude Code、OpenCode、Pi、Grok 或 Local Review 命令。Runtime 会把已接受结果继续送入 Review/Feedback 循环。

每次 block run 都会写入可追踪产物，包括 prompt、stdout、stderr、report、metadata 和可用的监控命令。

使用 Plan Package 自定义 executor profile 前，需要通过 `planweave trust executor <profile>` 完成信任。

## Agent Skills

仓库在 `skills/` 下提供了几个职责明确的 agent skill：

- `plan-maker`：从模糊目标或少量代码上下文设计 PlanWeave package-shaped draft；用户要求 materialize 时，通过 draft validate/import 写入。
- `plan-importer`：从强 source docs 创建 PlanWeave package draft，再通过 draft validate、preview 和 import 写入。
- `plan-auditor`：审查已经写好的 PlanWeave plan，检查目标覆盖、对象生命周期、契约漂移、弱 prompt 和不可验证完成条件。
- `plan-coordinator`：作为主 agent 持续推进整个 PlanWeave 执行循环，分发实现、评审和恢复任务。
- `plan-runner`：执行一个 implementation block，并产出完成报告。
- `plan-reviewer`：执行一个 review gate，并产出结构化 `passed` 或 `needs_changes` 结果。
- `plan-recovery`：诊断和恢复 stale current refs、state/results drift、blocked/diverged work 和 submit retry 混乱。

可以用 `skills` CLI 安装：

```bash
npx skills@latest add GaosCode/PlanWeave
```

## Agent 工作流

安装 skills 后，在目标项目里按这个流程使用：

1. 让 agent 创建或导入计划。

```text
Use skill: plan-maker
Create a PlanWeave plan for this project from the goal below...
```

如果已经有 PRD、roadmap、issue 或架构说明，用 `plan-importer`。Materialize 计划时，`plan-maker` 会写出 package-shaped draft 并运行：

```bash
planweave package-draft validate --draft-root <draft> --json
planweave package-draft quality --draft-root <draft> --json
planweave package import --from <draft> --dry-run --json
planweave package import --from <draft> --apply --json
```

2. 让 coordinator 执行计划。

```text
Use skill: plan-coordinator
Run the current PlanWeave package. Route implementation to plan-runner, review gates to plan-reviewer, and recovery work to plan-recovery.
```

3. 让 coordinator 分发聚焦任务。

coordinator 应该一次只分配一个明确 block。实现类 agent 用 `plan-runner`；评审类 agent 用 `plan-reviewer`；异常状态或 submit retry 问题用 `plan-recovery`。

4. 需要排查时用 CLI 查看状态。

```bash
planweave status
planweave current
planweave explain <ref>
planweave graph inspect --view summary --json
planweave graph quality --json
planweave doctor
```

简单任务可以由一个 agent 直接使用 `plan-runner` 完成。复杂计划建议用 `plan-coordinator` 作为主控 agent，再把子任务分给 `plan-runner`、`plan-reviewer` 或 `plan-recovery`。

## MCP 与 ChatGPT 网页端生成计划

PlanWeave 内置本机 HTTP MCP server，可以让 ChatGPT 等 MCP client 直接使用 PlanWeave。MCP 工具可以检查和编写计划：初始化项目、创建任务画布、添加任务和 Blocks、连接依赖、编辑 prompt、配置 Review Pipeline、检查 graph quality，并导入 package draft。

如果要在浏览器里的 ChatGPT 使用 PlanWeave，VPS/headless 环境推荐使用 CLI MCP tunnel，本地可视化环境可以使用桌面端设置。你可以使用 ChatGPT Web 来制定计划：描述项目目标，让它先写出临时 draft root 下的 package-shaped draft，dry-run 校验和质量检查，预览导入，再事务式 apply。

VPS 推荐使用 systemd。MCP server 只监听 loopback，OpenAI `tunnel-client` 通过出站长连接接入，systemd 负责服务生命周期。

```bash
sudo mkdir -p /etc/planweave /srv/planweave
sudo chmod 700 /etc/planweave

planweave mcp tunnel download
planweave mcp tunnel configure --tunnel-id tunnel_xxx
planweave mcp tunnel print-systemd \
  --planweave-home /srv/planweave \
  --env-file /etc/planweave/mcp-tunnel.env
```

把 Runtime API key 写入 systemd environment file，不写入 PlanWeave 的普通 JSON 配置：

```bash
PLANWEAVE_HOME=/srv/planweave
OPENAI_RUNTIME_API_KEY=...
```

这个文件应只允许服务所属用户读取：

```bash
sudo chmod 600 /etc/planweave/mcp-tunnel.env
```

把打印出来的 service 安装为 `planweave-mcp-tunnel.service` 后运行：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now planweave-mcp-tunnel
journalctl -u planweave-mcp-tunnel -f
```

本地桌面端路径：

1. 在桌面应用打开 **Settings -> MCP Tunnel**。
2. 下载或选择 OpenAI [`tunnel-client`](https://github.com/openai/tunnel-client)。
3. 填入 Tunnel ID 和 Runtime API key，然后启动 secure tunnel。
4. 在 ChatGPT 中用 Tunnel 连接方式添加 PlanWeave。

连接完成后，ChatGPT 可以通过 MCP 工具创建、检查、校验和导入 PlanWeave 计划。

源码级 MCP server 配置见 [Development](../DEVELOPMENT.md)。

## Auto Run

Auto Run 会领取 ready work、调用所选 executor、提交产物、继续 review-feedback 循环，并把每次运行记录为 session。

```bash
planweave run --once --json
planweave run --parallel --step-limit 20 --timeout 120000 --json
planweave run --scope task --task T-001 --once --json
planweave run --scope block --block T-001#B-001 --once --json
```

executor 按 block、task 和 package 默认配置解析。使用 `--executor <profile>` 显式覆盖本次运行，使用 `--canvas <canvas-id>` 选择 canvas。

PlanWeave Desktop 提供范围化运行控制、实时进度和 session 历史。CLI 用户可以用以下命令查看同一份 runtime state：

```bash
planweave run-status --follow --json
planweave run-sessions --json
planweave run-session <session-id> --json
```

### ACP runners

PlanWeave 为 Codex、Claude Code、OpenCode、Pi 和 Grok 提供显式 ACP profile：`codex-acp`、`claude-code-acp`、`opencode-acp`、`pi-acp` 和 `grok-acp`。

安装所选 Agent 并完成认证，然后检查并运行对应 profile：

```bash
planweave executors test codex-acp --json
planweave run --once --executor codex-acp --timeout 120000 --json
```

ACP 预检会协商所选 Agent 声明的认证方式，并可使用已经配置好的非交互认证凭据。如果需要用户操作，CLI 和 Desktop 会显示下一步；交互式登录仍由 Agent 自己处理，PlanWeave 不会自动启动。PlanWeave 不会在 run metadata 或 Desktop state 中持久化 Agent 凭据值。

ACP run 通过 CLI 和 Desktop 提供结构化进度、产物、usage 和交互请求。

## 分布式运维指南

PlanWeave 可以运行 **Coordinator**（`planweave-server`），把远程 Block 调度到独立部署的 **Agent Host**（`planweave-agent-host`）上执行。远程执行仅支持 **ACP**：Host 用本地配置的 ACP agent profile，在已映射的 workspace 中启动 Agent。Provider API Key、Agent 登录态和 Git 凭据只留在 Host 机器上。Git clone/fetch/push 属于 Block 内容或 Host 侧环境准备，不是 Coordinator 功能。

生产环境使用 HTTPS。明文 HTTP **仅用于开发**，且只有双方都设置 `allowInsecureDevelopment: true`、并绑定字面量 loopback（`127.0.0.1` / `::1`）时才被接受。

### 安装 CLI

在本 monorepo 中（完成 `pnpm install` 与 `pnpm -r build` 后）：

```bash
pnpm --filter @planweave-ai/server exec planweave-server --help
pnpm --filter @planweave-ai/agent-host exec planweave-agent-host --help
```

发布包名为 `@planweave-ai/server`（二进制 `planweave-server`）和 `@planweave-ai/agent-host`（二进制 `planweave-agent-host`）。均需 Node.js 22.5+。

### 启动 Coordinator

编写绝对路径 JSON 配置（`server-config/v1`）。配置中只保存 operator bearer token 的 **SHA-256 摘要**，不要写入明文 token。

```bash
# 为 operatorCredentials 生成 tokenSha256（token 长度 32–256，字符集 [A-Za-z0-9_-]+）
node -e "const {createHash}=require('node:crypto'); console.log(createHash('sha256').update(process.argv[1]).digest('hex'))" "$OPERATOR_TOKEN"
```

生产形态配置（仅占位符）：

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

启动与停止：

```bash
planweave-server serve --config /etc/planweave/server.json
# 或: PLANWEAVE_SERVER_CONFIG=/etc/planweave/server.json planweave-server serve
# SIGINT / SIGTERM 会排空在途工作并干净退出
```

就绪后 CLI 打印安全 JSON 摘要（`status`、`publicUrl`、bind host/port、project ids），不会打印 token 或 data-directory 秘密。

未鉴权健康检查：

```bash
curl -fsS https://coordinator.example.com:7443/healthz
curl -fsS https://coordinator.example.com:7443/readyz
curl -fsS https://coordinator.example.com:7443/version
```

仅当服务已准备好接受 operator 变更时，`/readyz` 返回 HTTP 200；迁移或对账期间可能返回 503。

### TLS 与开发传输

| 模式 | `publicUrl` | `tls` | `allowInsecureDevelopment` |
| --- | --- | --- | --- |
| 生产 | `https://…` origin（端口须与 `bind.port` 一致） | 必须提供证书与私钥绝对路径 | 省略 / `false` |
| 仅本地开发 | `http://127.0.0.1:<port>` | 省略 | `true`（bind host 必须是 loopback） |

连接开发 Coordinator 的 Host 配置需设置 `coordinator.allowInsecureDevelopment: true`，并使用同一 loopback origin。生产环境若使用私有 CA，在 Host 上设置 `coordinator.caCertificatePath` 为绝对路径 PEM。

### 安装并登记 Agent Host

1. 为 Host 准备绝对路径 `dataDirectory` 与 `workspaceRoot`。
2. 在 `workspaceRoot` 下创建 `workspaces[].path` 中的相对目录（禁止 `..` 与绝对路径）。
3. 配置 ACP profile：绝对路径 `command`、可选 `args`，以及所需环境变量**名称**（值在 preflight/run 时从 Host 进程环境读取；密钥不写入配置文件）。

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

运维命令：

```bash
planweave-agent-host preflight --config /etc/planweave/agent-host.json
# 由 server admin 创建一次性 enrollment grant（见下方 Operator HTTP），然后：
planweave-agent-host enroll --config /etc/planweave/agent-host.json --code pw_enroll_...
# 重新登记 / 轮换本地凭据（在安全时替换既有 active 凭据）：
planweave-agent-host enroll --config /etc/planweave/agent-host.json --code pw_enroll_... --replace
planweave-agent-host status --config /etc/planweave/agent-host.json
planweave-agent-host run --config /etc/planweave/agent-host.json
planweave-agent-host revoke --config /etc/planweave/agent-host.json
```

`preflight`、`enroll`、`status`、`revoke` 输出 JSON 诊断（`credential`、`capacity`、`capabilities`、`recoverableExecutions`，以及可选的 `hostId` / `actionableError`）。`run` 会持续运行守护进程，直到 SIGINT/SIGTERM，或出现终端级传输/鉴权失败。

Host 凭据保存在 Host 的 `dataDirectory`（例如 `credentials.json`）。Provider 与 Git 凭据仍只存在于 Host 本地环境或 Agent 自身配置。

### 可选的真实 ACP 兼容性 smoke

PlanWeave 可通过公共 ACP 接口（而非 CLI runner）对一台 **Host 本地 ACP agent** 做兼容性 smoke。该路径为 **opt-in**，普通 CI 不会启动真实 agent，也不需要 provider 凭据。

支持的 Host 本地 profile id（来自 Runtime registry）：`codex-acp`、`claude-code-acp`、`opencode-acp`、`grok-acp`、`pi-acp`。版本策略遵循 Runtime ACP SDK authority（`protocolVersion` / verified adapter 元数据）；smoke 断言协议与契约结果，不断言 provider 特有回复文本。

```bash
# 列出支持的 profile（不启动 agent）
planweave-agent-host real-acp-smoke --list-profiles

# 软门禁：缺二进制/登录 → skipped 证据，exit 0
PLANWEAVE_REAL_ACP=1 planweave-agent-host real-acp-smoke --evidence /tmp/real-acp.json

# 硬门禁：缺二进制/登录 → failed 证据，exit 1
PLANWEAVE_REAL_ACP_REQUIRE=1 planweave-agent-host real-acp-smoke --require --profile codex-acp

# 可选 monorepo helper（优先使用已构建 Host bin，否则 tsx）
PLANWEAVE_REAL_ACP=1 node scripts/real-acp-host-smoke.mjs --list-profiles
```

环境变量：

| 变量 | 含义 |
| --- | --- |
| `PLANWEAVE_REAL_ACP=1` | 软门禁：启用 smoke；前置条件不足则 skip |
| `PLANWEAVE_REAL_ACP_REQUIRE=1` | 硬门禁：前置条件不足则 fail |
| `PLANWEAVE_REAL_ACP_PROFILE=<id>` | 固定 Host 本地 profile id |

文档与证据保持无密钥：preflight 只记录可执行路径、非秘密版本字符串、协议/SDK 版本与 capability 名称。不要把 API key 或登录 token 写入 PlanWeave 配置；agent 鉴权仍留在 Host 本地。若 ACP 启动或 capability 协商失败，`real-acp-smoke` **不会**回退到 CLI executor。

### 可选的已鉴权 VPS / TLS 端到端

PlanWeave 可将 **Coordinator + Agent Host** 的安装、证书校验传输、一次性 enrollment、有界 fixture 调度、网络中断后的事件 cursor 回放与清理，作为 **opt-in** 场景运行。普通 CI 不会启动该路径。

两种明确标注的环境类别：

| `environmentClass` | 含义 |
| --- | --- |
| `local-tls-fixture` | 一次性 **loopback** Server + Host，使用临时自签 TLS（OpenSSL）。覆盖同一套 enroll / dispatch / replay / revoke 契约。**不是**生产 VPS 声明。 |
| `remote-vps` | 操作者提供的一次性 VPS。连接信息**只**来自仓库外的绝对配置路径与环境变量中的 token。仓库内不得硬编码主机名、SSH 或密钥。 |

```bash
# 软门禁：缺 openssl/构建产物/远程配置 → skipped 证据，exit 0
PLANWEAVE_VPS_E2E=1 planweave-server vps-e2e --evidence /tmp/vps-e2e.json

# 硬门禁
PLANWEAVE_VPS_E2E_REQUIRE=1 planweave-server vps-e2e --require --profile local-tls-fixture

# 远程 VPS（配置与 token 均在仓库外）
export PLANWEAVE_VPS_E2E_CONFIG=/absolute/path/outside-repo/vps-e2e.json
export PLANWEAVE_VPS_OPERATOR_TOKEN=...   # 永不提交
PLANWEAVE_VPS_E2E=1 planweave-server vps-e2e --profile remote-vps --evidence /tmp/vps-e2e.json

# monorepo helper（优先已构建 Server bin，否则 tsx）
PLANWEAVE_VPS_E2E=1 node scripts/vps-authenticated-e2e.mjs --profile local-tls-fixture
```

环境变量：

| 变量 | 含义 |
| --- | --- |
| `PLANWEAVE_VPS_E2E=1` | 软门禁：启用 e2e；前置条件不足则 skip |
| `PLANWEAVE_VPS_E2E_REQUIRE=1` | 硬门禁：前置条件不足则 fail |
| `PLANWEAVE_VPS_E2E_PROFILE` | `local-tls-fixture`（默认）或 `remote-vps` |
| `PLANWEAVE_VPS_E2E_CONFIG` | 远程配置 JSON 的绝对路径（仅 remote-vps） |
| `PLANWEAVE_VPS_OPERATOR_TOKEN` | 远程配置默认引用的 operator bearer token 环境变量名 |

远程配置 schema（`planweave.vps-e2e-config/v1`）字段：`coordinatorUrl`（https origin）、`operatorTokenEnv`（环境变量**名**，不是 token 本身）、可选 `caCertificatePath`、`hostConfigPath`、`projectId`，以及可选 `canvasId` / `blockRef` / `evidencePath`。证据 JSON 会脱敏：仅 digests 与 identity id —— 不含 endpoint、token、PEM、enrollment code 或完整日志。

同一台机器上的 Host 本地真实 agent 兼容性请复用[可选的真实 ACP smoke](#可选的真实-acp-兼容性-smoke) 门禁（`PLANWEAVE_REAL_ACP`）。VPS e2e 默认 fixture 使用 mock ACP 进程，因此本地/软门禁运行不依赖 provider 登录。

### 线上发布门禁与回滚检查

一个面向发布的命令区分三层门禁。**被 skip 的 live 测试绝不能当作通过**（不能用于 supported-version 或 pre-release 就绪判定）。证据只允许保存脱敏摘要与 artifact digest，不得写入基础设施密钥、端点、token、PEM 或 provider 凭据。

| 层级 | 要求 | 命令 / 证据 |
| --- | --- | --- |
| 确定性多进程套件 | **CI 必跑** | `realProcess*.test.ts`（mock ACP，无密钥） |
| 本地真实 ACP 兼容 | **声明 supported-version 前必过** | `planweave-agent-host real-acp-smoke` 硬门禁证据 |
| 远程已认证 VPS | **预发布证据必过** | `planweave-server vps-e2e --profile remote-vps` 硬门禁证据（仅 `environmentClass=remote-vps`） |

```bash
# 打印检查清单（层级、回滚约束、归属）
planweave-server release-gate --checklist

# 仅 CI 层（跑确定性多进程套件）
planweave-server release-gate --run-deterministic --report /tmp/release-gate.json

# 评估脱敏证据，得到完整 pre-release 判定
planweave-server release-gate \
  --deterministic-evidence /tmp/det.json \
  --real-acp-evidence /tmp/real-acp.json \
  --vps-evidence /tmp/vps-e2e.json \
  --report /tmp/release-gate.json

# monorepo 助手
node scripts/planweave-release-gate.mjs --checklist
```

**兼容边界**（门禁与 dispatch 前强制）：

- 线协议：仅支持 `agentHostProtocolVersion`（当前为 `1`）；不兼容协议版本 fail-closed。
- Server / Agent Host / `distributed-protocol` 的 package **主版本必须一致**。
- 受支持 ACP Agent 必须协商 Host ACP SDK 协议版本；ACP 主版本不兼容 fail-closed，**禁止 CLI 回退**。
- 优雅降级仅允许 **同一 package major**，且须先做状态备份。

**回滚约束**（需运维确认；门禁会写入报告）：

- 升级前备份 Server 与 Host 的 `dataDirectory`；回滚时恢复备份。
- **禁止**为“干净启动”而重置数据库。
- **禁止**静默重跑被中断的 Block；只能使用显式生命周期动作（`resume_same_session`、`retry_new_attempt`、`cancel`、`fail`、`block`）。
- 使用 `enroll --replace` 轮换 Host 凭据，并撤销旧 grant/host。
- 收集 live 证据后清理临时 harness，并撤销一次性 enrollment 材料。

**证据规则：** live 证据 14 天后过期（`generatedAt` 或文件 mtime）。运维拥有一次性 VPS 与 Host 本地 provider 登录；CI 只拥有确定性套件。门禁输入为证据路径与 package 版本；输出为含层级状态、digest、兼容检查、回滚清单与 `releaseReady.{ci,supportedVersionRelease,preRelease}` 的 JSON 报告。

关联 RV-001/002/003 与确定性套件复跑、诚实记录 live 阻塞的证据检查点见 [distributed-remote-execution-checkpoint.md](distributed-remote-execution-checkpoint.md)。

### Operator HTTP 接口

鉴权路由需要 `Authorization: Bearer <operator-token>`，并使用 TLS（或 loopback 开发模式）。server-admin 可登记与吊销 Host；项目作用域凭据只能对自己的 `projectIds` 做 dispatch 与观测。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/v1/host-enrollments` | 创建 enrollment grant（`expiresAt`、`credentialExpiresAt`）→ `{ enrollmentCode, expiresAt }` |
| `GET` | `/api/v1/hosts` | 列出 Host（`cursor`、`limit`）— capacity、lastSeenAt、revokedAt |
| `GET` | `/api/v1/hosts/:hostId` | Host 详情 |
| `POST` | `/api/v1/hosts/:hostId/revoke` | 服务端吊销 Host 凭据并断开连接 |
| `POST` | `/api/v1/remote-operations` | 调度 Block（`projectId`、`canvasId`、`blockRef`、`idempotencyKey`）→ operation 视图（HTTP 202） |
| `GET` | `/api/v1/remote-operations/:operationId` | 观察 operation / attempt / runtime binding |
| `POST` | `/api/v1/remote-operations/:operationId/actions` | 生命周期动作：`cancel`、`resume_same_session`、`retry_new_attempt`、`fail`、`block` |
| `GET` | `/api/v1/remote-operations/:operationId/events` | 回放 ACP 事件（`afterCursor`） |
| `GET` | `/api/v1/remote-operations/:operationId/interactions` | 列出待处理交互 |
| `POST` | `/api/v1/remote-operations/:operationId/interactions/respond` | 结算交互 |

示例：创建 enrollment 并查看 Host 就绪情况：

```bash
curl -fsS -X POST "https://coordinator.example.com:7443/api/v1/host-enrollments" \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{"expiresAt":"2030-01-01T00:00:00.000Z","credentialExpiresAt":"2030-01-08T00:00:00.000Z"}'

curl -fsS "https://coordinator.example.com:7443/api/v1/hosts?limit=50" \
  -H "Authorization: Bearer $OPERATOR_TOKEN"
```

示例：dispatch 并观察 Block：

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

取消 / 恢复使用 `POST .../actions`，请求体需包含当前 attempt 身份字段（`actionId`、`operationId`、`dispatchId`、`executionAttemptId`、`expectedAttemptVersion`、lease 字段与 `kind`）。提交前请先读取最新的 operation 观察结果。支持的 `kind`：

- `cancel` — 请求协作取消进行中的 attempt
- `resume_same_session` — 在有 fence 与恢复证据时恢复被中断的会话
- `retry_new_attempt` — 在不可恢复中断后启动新的 dispatch/attempt
- `fail` / `block` — 在需要操作或已中断状态下给出终端结果

对同一 project/canvas/block 使用相同 `idempotencyKey` 可实现幂等 re-dispatch。

### 轮换或吊销 Host 凭据

1. **服务端吊销**：`POST /api/v1/hosts/:hostId/revoke`（server admin）。Host 会被断开；本机凭据材料不会自动删除。
2. **Host 本地吊销**：`planweave-agent-host revoke --config …` 将本地凭据标记为 revoked，`run` 将不再使用它。
3. **轮换**：创建新的 enrollment grant，再在 Host 上执行 `planweave-agent-host enroll --config … --code … --replace`（仅在 durable execution state 允许安全替换时）。

### 常见故障

| 现象 | 可能原因 | 排查 |
| --- | --- | --- |
| CLI `server_cli_usage` / `agent_host_cli_usage`（退出码 2） | 参数错误 | `serve --config <绝对路径>`；Host 命令需要 `--config`；`enroll` 需要 `--code` |
| `server_tls_configuration_required` | 生产配置缺少 TLS | 提供 `tls` 与 `https` `publicUrl`，或使用 loopback 开发模式 |
| `server_insecure_development_requires_literal_loopback` | 非 loopback 启用了不安全模式 | bind 与 public URL 必须是 `127.0.0.1` / `::1` |
| `/readyz` → 503 | 未就绪 / draining / reconciling | 等待启动完成；排空期间不要 dispatch |
| Operator HTTP 426 `operator_insecure_transport` | 未开开发模式的 HTTP | 使用 TLS，或在两端启用 loopback 不安全开发模式 |
| Operator HTTP 401 | 缺少或错误的 bearer token | token 必须对应配置中的 `tokenSha256` |
| Operator HTTP 403 | 作用域 / 需要 admin | enrollment 与 host 吊销需要 `serverAdmin`；项目 dispatch 需要项目作用域 |
| Host `credential: missing` | 尚未 enroll | 使用新的 grant 执行 `enroll` |
| Host `credential: revoked` / `expired` | 本地或服务端生命周期结束 | 用新 grant 配合 `--replace` 重新 enroll |
| Host `run` 时 `agent_host_auth_failed` | 服务端已吊销或 token 不匹配 | 本地 revoke 后重新 enroll |
| Host `agent_host_profile_environment_missing:…` | 缺少必需环境变量 | 在 Host 上导出 Provider key 后再 preflight/run |
| Host `agent_host_workspace_not_configured` | workspace id 不匹配 | `workspaces[].id` 必须与 Coordinator 信任的 PlanWeave project id 一致 |
| Dispatch 一直无法调度 | 没有在线 Host / 能力不匹配 | 确认 Host `lastSeenAt`、`capacity` 与重叠的 `capabilities` |
| Cancel / resume 返回 409 | attempt 版本过期或 lease 错误 | 重新获取 operation 视图，使用当前 `expectedAttemptVersion` 与 lease id |

Coordinator 上的项目 package 仍是 Block 内容的权威来源。远程运行后，用常规的 `planweave status` / `planweave explain <ref>` / `planweave doctor` 检查同一 package；这些 JSON 投影会包含 remote ownership，但不会暴露 Host 秘密。

### 自动化 walkthrough 覆盖范围

仓库集成测试 `packages/server/src/__tests__/operatorWalkthrough.test.ts` 覆盖干净的临时流程：启动 Coordinator、preflight/enroll Host、观察 Host capacity、创建/观察 remote operation、停止并重启 Host 与 Coordinator、吊销凭据并关闭。该测试不依赖 README 内容。完整 ACP 执行成功、交互权限结算与生产 TLS 证书签发仍需人工操作，或由其他包测试覆盖。

## 未来方向

PlanWeave 将继续扩展三个方向：

- **Auto Run**：继续改进运行控制、异常恢复和长期运行稳定性。
- **协作规划**：让团队共同编辑和完善同一张任务画布。
- **跨主机执行**：强化多 Host 机群的调度、容量与恢复能力。

## 开发

贡献者环境、仓库结构、测试命令和本地打包说明见 [Development](../DEVELOPMENT.md)。

## License

MIT。详见 [LICENSE](../LICENSE)。
