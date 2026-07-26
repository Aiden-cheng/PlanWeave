# 问题追踪：GitHub（代码托管与问题追踪平台）

本仓库的问题与需求记录位于 `origin`（默认远端）指向的 GitHub 仓库。所有操作使用 `gh`（GitHub Command Line Interface，GitHub 命令行界面）。

## 约定

- 创建问题：`gh issue create --title "..." --body "..."`
- 阅读问题：`gh issue view <编号> --comments`
- 列出问题：`gh issue list --state open --json number,title,body,labels,comments`
- 评论问题：`gh issue comment <编号> --body "..."`
- 添加或移除标签：`gh issue edit <编号> --add-label "..."` 或 `--remove-label "..."`
- 关闭问题：`gh issue close <编号> --comment "..."`

在此仓库内运行时，`gh` 会根据 Git 远端自动识别目标仓库。

## 拉取请求（Pull Request，PR）作为分诊入口

拉取请求作为请求入口：否。

若以后改为“是”，分诊技能应使用对应的 `gh pr` 命令读取、列出、评论、打标签或关闭拉取请求。

## 技能操作映射

- 当技能要求“发布到问题追踪器”时，创建 GitHub 问题。
- 当技能要求“获取相关工单”时，运行 `gh issue view <编号> --comments`。

## 导航分解（Wayfinding）操作

- 路线图：一个带 `wayfinder:map` 标签的 GitHub 问题。
- 子任务：作为路线图的 GitHub 子问题；不可用时，写入路线图任务清单，并在子问题顶部注明 `Part of #<编号>`。
- 阻塞关系：优先使用 GitHub 原生问题依赖；不可用时，在子问题顶部注明 `Blocked by: #<编号>`。
- 可执行前沿：选择未分配且没有未关闭阻塞项的开放子任务。
- 认领：`gh issue edit <编号> --add-assignee @me`。
- 完成：先评论结果，再关闭问题，并向路线图补充上下文指针。
