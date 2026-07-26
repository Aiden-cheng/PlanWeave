## 长期维护规则

- `main` 仅用于同步 `upstream/main`（官方上游主分支）。
- 日常维护从 `maintenance` 创建短期分支。
- 短期分支格式：

  ```text
  fix/<scope>-<short-description>
  feat/<scope>-<short-description>
  docs/<scope>-<short-description>
  chore/<scope>-<short-description>
  ```

- 所有 Node.js（JavaScript 运行时）和 pnpm（包管理器）命令使用：`mise exec -- pnpm <command>`。
- 不提交 `mise.toml`、`node_modules/`、`dist/`、凭据、临时记录或构建产物。

### 提交标题

提交标题遵守：

```text
<type>(<scope>): <description>
```

例如：

```text
fix(runtime): preserve event redaction boundaries
feat(desktop): add model selection
docs(contributing): clarify maintenance setup
chore(agents): configure maintenance environment
```

范围选取原则：

- 修改某个包的业务逻辑，使用包名：`runtime`、`desktop`、`cli`、`mcp`。
- 修改明确子系统，使用子系统名：`acp-runner`、`auto-run`、`project-graph`。
- 修改依赖、构建、发布或自动化，使用：`deps`、`build`、`release`、`ci`。
- 修改说明文档，使用最贴近文档主题的：`readme`、`contributing`、`skills`。
- 智能体维护可使用 `agents`。

### 版本与发布

- 普通修复、功能开发、测试、重构和文档修改：不得修改任何版本号，不得运行 `pnpm sync:versions`（版本元数据同步命令），不得创建 `vX.Y.Z`（版本标签），不得发布。
- 只有用户明确要求“准备正式发布”，并指定目标包与目标版本时，才可以修改版本号。
- 版本同步命令只负责同步版本元数据；它不构建、不测试、不创建标签、不发布。
- 正式发布前后仍须按用户明确授权，分别完成验证、构建、创建 `vX.Y.Z` 标签和发布。
- 日常仅可运行 `mise exec -- pnpm check:versions`（版本一致性检查）；若检查失败，只报告不一致原因，不得自行改版本。

## Agent skills

### Issue tracker

工作项记录在 GitHub（代码托管与问题追踪平台）问题中。参见 `docs/agents/issue-tracker.md`。

### Triage labels

使用默认分诊标签词汇。参见 `docs/agents/triage-labels.md`。

### Domain docs

使用多上下文布局：根目录 `CONTEXT-MAP.md` 指向各包的 `CONTEXT.md`，系统级架构决策记录位于 `docs/adr/`。参见 `docs/agents/domain.md`。
