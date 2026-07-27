# T43 原生页签菜单、快捷键与焦点路由留痕

## 1. 任务边界

- 对应任务：第三阶段 `T43`。
- 对应需求：R11、R13、R30、R31 的页签菜单、键盘、状态与焦点子集。
- 本次只实现原生页签命令及其聚焦窗口路由，不进入 T44 契约门禁整理、T45 双平台桌面 E2E 或 T46 阶段验收。
- 未新增数据库、SQL、seed、capability、持久化字段、产品环境变量、依赖或初始化数据。

## 2. 实际实现

### 2.1 单一原生命令通道

`src-tauri/src/menu.rs` 新增顶层“页签”菜单：

- 关闭当前页签：`Cmd/Ctrl+W`；
- 重新打开最近关闭的页签：`Cmd/Ctrl+Shift+T`；
- 下一/上一页签：`Ctrl+Tab` / `Ctrl+Shift+Tab`；
- 关闭其他、关闭右侧、关闭全部；
- 所有页签。

关闭窗口继续使用 `Cmd/Ctrl+Shift+W`。所有页签命令继续通过既有 `WORKBENCH_MENU_EVENT` 发送；React 没有注册同组合键的全局 `keydown`，因此不存在第二条命令分发链或双触发路径。

### 2.2 聚焦窗口状态

Rust/TypeScript `EditorMenuState` 同步增加 `TabMenuState`：

- `tabCount`；
- `activeTabIndex`；
- `recentlyClosedCount`。

`EditorMenuStateRegistry` 仍按窗口标签保存状态，只将聚焦窗口状态应用到系统菜单。busy、无活动页签、无右侧项或无最近关闭项时相应命令禁用；P2 和无页签 P1 投影零值，不发送空成功事件。

### 2.3 复用与提交边界

- 原生命令进入 P1 既有 `workbenchMenuHandlerRef`，再委托唯一 `WorkspaceTabManager`。
- 关闭当前/其他/右侧/全部复用 T40 的 `closeWorkspaceTabs` 和同一个 `TabSettlementDialog`，不复制保存或冲突判断。
- 重开最近关闭复用 `reopenWorkspaceTab`，仍先经过 Rust 路径身份解析。
- “所有页签”只向既有 `WorkspaceTabBar` 发打开请求，真实菜单仍由 `TabOverflowMenu` 消费共享 `TabMenu`；打开后聚焦第一个可执行项。
- 前端复用审查未发现需要新增的组件、hook、util 或 gateway；DESIGN 只需同步消费者事实，不新增视觉 token。

## 3. 测试与证据

### 3.1 自动化

- `pnpm test:tabs`：70/70。
- `pnpm test`：
  - Node 独立回归 30/30；
  - Vitest 32 个文件 267/267；
  - Rust 203 项通过，另 1 项手动性能探针忽略。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --all-features`：203 项通过，另 1 项忽略。
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过。
- `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`：通过。
- `pnpm build`：通过。
- `pnpm licenses:check`：727 个 Node 包、511 个 Rust 包、0 个阻断项。
- `pnpm test:e2e`：当前代码 macOS Tauri/WebKit 11/11 通过。

新增自动化覆盖：

- 原生页签 action 与 TypeScript 常量 parity；
- 页签菜单启用策略；
- 两个窗口 registry 状态互不污染；
- 原生命令复用 manager、最近关闭和批量结算；
- 原生“所有页签”请求打开共享溢出菜单并聚焦首项。

### 3.2 macOS 原生走查

使用当前代码构建隔离的 `Plainroot E2E.app`，以临时状态目录和临时工作区验证：

- 系统菜单栏显示真实“页签”菜单及全部命令；
- 两个打开页签时，关闭当前、下一/上一、关闭其他、关闭全部和所有页签启用；无右侧项、无最近关闭项时对应命令禁用；
- 点击系统菜单“下一个页签”后，窗口标题、活动 tab、文件树选中和中央内容同步切换；
- `Cmd+W` 关闭当前页签但不关闭窗口；
- `Cmd+Shift+T` 重新打开刚关闭的页签并恢复为活动项。

WebDriver 的按键注入只到达 WebView，不能验证系统菜单 accelerator。一次尝试性断言因此失败并已移除，没有通过弱化业务断言或重试掩盖。Computer Use 对 `Ctrl+Tab` 的注入也未触发原生菜单，所以本次只把该菜单项和 accelerator 构建、策略与事件路由记为已验证，不把该组合键的真实系统输入写成通过。

## 4. 未验证与后续承接

- `Ctrl+Tab` / `Ctrl+Shift+Tab` 的真实 macOS 系统输入。
- Windows 原生菜单、快捷键、焦点窗口路由和辅助技术。
- 最新第三阶段提交的远端 macOS/Windows CI。
- 多窗口真实系统菜单切焦与 T42 重启恢复的组合 E2E。

以上由 T45～T46 承接；当前不得据此宣称完整 R13/R30、第三阶段完成或双平台通过。

## 5. 相关文档

- 需求与阶段状态：`../requirement.md`。
- 第三阶段计划：`plan.md`。
- 设计规范：仓库根 `DESIGN.md`。
- 桌面底座架构：`../architecture/desktop-foundation.md`。
- Markdown 编辑架构：`../architecture/markdown-document-editing.md`。
