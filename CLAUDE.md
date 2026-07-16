# CLAUDE.md

> 始终用简体中文与用户协作；命令、代码、日志和文件原文可保持原样。

## 入口职责

- 仓库级规则以 [AGENTS.md](AGENTS.md) 为准，本文件不复制完整约束。
- 产品范围与验收见 [`requirement.md`](agent-works/markdown-editor-desktop/requirement.md)，当前阶段见对应阶段目录的 `plan.md`。
- 前端设计规范见 [DESIGN.md](DESIGN.md)，页面开发按 [`page-development-workflow.md`](agent-works/markdown-editor-desktop/page-development-workflow.md) 执行。
- HTML 原型位于 `agent-works/markdown-editor-desktop/prototypes/`，只作为交互与视觉证据，不作为生产代码复制。

## 工作方式

- 改动前先读 `AGENTS.md`、相关需求、当前阶段计划和同类实现；页面任务再读 `DESIGN.md`。
- 当前尚无正式工程和已验证命令，不得凭计划猜测安装、测试、构建或启动流程。
- 坚守本地文件安全、一目录一窗口、真实状态反馈和跨平台边界；不实现当前阶段之外的假功能。
- 需求、计划、留痕与验证证据归档到同一功能目录；不在用户未要求时提交或推送。

## Claude 记忆

- 仓库代码和文档优先于外部记忆；冲突时以当前仓库事实为准。
- 记忆只保留仓库中不易发现的长期偏好、决策原因和事实源指针，不保存阶段流水、临时失败、测试数字快照或已写入仓库的规则副本。
