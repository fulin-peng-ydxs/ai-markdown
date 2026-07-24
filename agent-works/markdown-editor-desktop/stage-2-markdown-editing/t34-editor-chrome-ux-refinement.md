# T34 编辑工具栏与状态栏信息层级收口

## 功能的详细需求

- 对应需求：R3、R6、R11、R30、R31；承接 P1 `7.1.2` 的编辑、反馈与键盘可达子集，以及 `7.1.3` 的窄窗口退化子集。
- 同一文档的持续保存状态只显示一次，避免工具栏和状态栏重复表达同一事实。
- 保存、另存副本和当前文档查找属于主操作，在窄桌面窗口中不得随格式工具滚出可视范围。
- 图片插入与低频资源目录设置归入同一资源组；资源目录设置继续使用真实既有弹层，不新增第二套菜单或偏好状态。
- 状态栏恢复当前文档相对路径；长路径允许视觉省略，但完整值必须通过 tooltip 获取。
- 空文档占位只表达可执行意图，不解释占位符不会写入文档这一通用行为。

本任务不改变保存、图片、资源偏好、文件或窗口业务语义，不新增页签、大纲、搜索、阅读或主题能力。

## 功能开发的实际结果

- `EditorToolbar` 改为两区布局：
  - 左侧模式、历史和排版格式独立横向滚动。
  - 右侧保存/处理冲突、另存副本、当前文档查找和图片资源组固定可见。
- 工具栏不再渲染 `SaveStatus`；`DocumentStatusBar` 成为持续保存状态的唯一消费者。
- 图片选择保留明确“图片”按钮；低频资源目录设置收敛为同组 `⋯`，其 `aria-label` 和 `title` 仍为“设置图片资源目录”，点击继续打开既有 `AssetDirectoryDialog`。
- 状态栏新增当前文档相对路径，并用 `title` 暴露完整路径。
- 空文档占位精简为“开始输入 Markdown”。
- 全量测试暴露“窗口关闭结算”用例错误依赖 Milkdown 正文在默认超时内渲染；该测试已改为等待真实 `SaveStatus` 和 settlement listener，不通过延长超时或重试掩盖并发时序。

审查提出的通知行纵向跳动本轮未修改。该行承载兼容性、adapter 错误和内容安全反馈，可能持续且多行；固定高度会截断信息，浮层会遮挡正文。当前没有真实像素与可访问性证据支持替换承载方式，因此保留内容流布局，并将其作为非阻塞视觉观察项，而不是宣称已修复。

## 功能开发的具体实施方案

### 代码与测试

- `src/features/editor/EditorToolbar.tsx`
  - 移除工具栏 `SaveStatus`。
  - 建立可滚动格式区和固定文档/资源操作区。
- `src/features/editor/DocumentEditorShell.css`
  - 工具栏使用 `minmax(0, 1fr) auto` 两列布局。
  - 只有格式区消费 `overflow-x: auto`；工具栏根节点不产生横向滚动。
- `src/features/editor/DocumentStatusBar.tsx`
  - 在 ready session 下呈现相对路径和完整值 tooltip。
- `src/features/workbench/WorkspaceWorkbench.css`
  - 路径项允许收缩并使用代码字体，不抢占更高优先级状态。
- `src/features/editor/DocumentEditorShell.tsx`
  - 精简空文档占位文案。
- `src/features/editor/DocumentEditorShell.test.tsx`
  - 锁定工具栏不重复保存状态、资源设置入口仍打开真实弹层和占位文案。
- `src/features/workbench/WorkspaceWorkbench.test.tsx`
  - 锁定单一保存状态、相对路径、固定主操作区和资源设置可访问名称。
  - 将窗口结算用例的前置条件收敛为 session ready 与监听器注册。
- `tests/e2e/specs/desktop-shell.e2e.mjs`
  - 在真实 Tauri/WebKit P1 中验证 1100、1050、820、740 px 四档窗口。
  - 断言整页/工具栏无横向溢出、格式区可滚动、固定操作区在工具栏边界内、保存/查找可见、保存状态唯一和路径存在。

### 复用判断

开发前检索了 `EditorToolbar`、`SaveStatus`、`DocumentStatusBar`、`AppDialog`、`AsyncStatePanel`、`AssetDirectoryDialog`、`focusContainment`、工具栏样式、P1 原型与 `DESIGN.md` 组件登记。

- 继续复用 `SaveStatus`、`ToolbarButton`、`AssetDirectoryDialog`、现有语义 token 和 gateway/test fixture。
- 没有新增 popover 或“更多”菜单。当前只有一个低频资源设置入口，为它建立菜单开合、焦点、Esc 和生命周期状态会引入高于收益的新交互模型；改用既有按钮在资源组内降权即可满足需求。
- 没有新增组件、hook、路径工具、API schema 或测试 mock 工厂，因此不存在第二份同职责实现。

### 文档同步

- `requirement.md`：更新 P1 当前事实、7.1.2 默认展示/验收和阶段 2 实施状态。
- `plan.md`：新增并完成 T34，同步 R3/R6/R11/R30/R31 映射、页面功能点、验证和实际落地。
- `DESIGN.md`：更新 `EditorToolbar`、`SaveStatus`、`DocumentStatusBar` 的稳定职责与 Known Gaps。
- `README.md`、`AGENTS.md`：只沉淀当前稳定能力与验证边界。
- `t32-stage-acceptance.md`：记录阶段验收后的 T34 补强，不改写当时的历史验收证据。

技术架构文档无需更新：现有 `architecture/markdown-document-editing.md` 已以单一 `DocumentSession`、统一命令总线、工具栏和持续状态栏描述边界，本次只调整同一页面内的信息位置与响应式层级，没有改变模块依赖、数据流、API、状态机或持久化契约。

## 上线部署操作

- 无数据库、SQL、seed、数据迁移或初始化数据变化。
- 无 Tauri capability、系统菜单、权限、环境变量、用户配置、偏好 schema、依赖、锁文件或脚本变化。
- 不需要额外部署步骤或回滚脚本。若需回退，只需整体回退 T34 的前端、测试和文档提交；用户 Markdown、恢复快照和工作区偏好均不受影响。
- 本任务完成本地提交，不在本任务内推送或发布。

## 验证情况

### 已执行并通过

- `pnpm typecheck`
- `pnpm test`
  - Node：许可证策略 4、永久删除反馈 4、路径 3、文件树 18、fixture 1。
  - Vitest：23 个文件、176/176。
  - Rust 默认门禁：180 通过、1 个手动性能探针忽略。
- `pnpm build`
  - 启动主包 444.34 kB。
  - 排版 chunk 337.06 kB。
  - 源码 chunk 544.41 kB；既有大块告警仍存在。
- `pnpm test:licenses`
- `pnpm licenses:check`：727 个 Node 包、508 个 Rust 包、0 个阻断项。
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
- `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --all-features`
  - 180 通过、1 个手动性能探针忽略。
- `pnpm tauri build --no-bundle`
- `pnpm test:e2e`
  - 本机 macOS 真实 Tauri/WebKit 9/9。
  - 新增 P1 1100/1050/820/740 px 工具栏与状态栏断言均通过。
- `git diff --check`

第一次全量 `pnpm test` 曾因窗口关闭结算测试等待无关的 Milkdown 正文渲染而出现 1 条失败；修正为等待被测契约的真实 session/监听状态后，目标用例 24/24 和全量 176/176 均通过。该失败未通过重试或延长超时隐藏。

### 未执行或未取得的证据

- T34 未推送，因此没有新的 GitHub Actions、Windows runner 或远端 artifact 证据；不得沿用 T31 的远端 8/8 结果宣称 T34 双平台通过。
- 未做 Windows 原生系统 UI、系统辅助技术、系统 IME、图片原生剪贴板/拖放人工验收。
- 未建立暗色 token，未做暗色像素验收。
- 长路径的完整 tooltip 契约已由组件测试覆盖，但没有用极端长路径做真实像素级截图验收。
- 通知行出现/消失的布局跳动仍是已知非阻塞观察项。
