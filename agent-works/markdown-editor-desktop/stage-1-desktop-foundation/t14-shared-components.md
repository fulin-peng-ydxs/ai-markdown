# T14 第一阶段复用组件与状态契约开发记录

## 功能的详细需求

- 任务：第一阶段 T14，承接 P1/P2 公共组件收口，以及 R11、R30、R31 在真实状态反馈、键盘焦点和无障碍基础范围内的子集。
- 页面依据：完整复核 P1 `prototypes/markdown-workbench.html`、P2 `prototypes/workspace-launcher.html`、正式 `DESIGN.md` 和页面开发流程；原型只作为区域/状态证据，不复制其私有颜色、假路径或演示行为。
- 主目标：基于 T12/T13 已出现的两个真实页面消费者，固化对话框和异步状态契约，避免 P1/P2 各自维护 Esc、焦点、状态优先级、live-region 与颜色语义。
- 对话框状态：打开后进入首个真实交互项；Tab/Shift+Tab 不离开模态任务；无可交互 loading 状态聚焦对话框本体；Esc/遮罩遵守关闭门禁；关闭或卸载后只在原触发器仍存在时返回焦点。
- 状态优先级：权限撤销/位置失效高于冲突，高于普通错误，高于保存/加载，高于脏/只读，高于 empty/ready；不支持编码/过大文件属于明确 warning，不伪装成普通 ready。
- 状态表达：组件从类型化状态自动派生语义 tone、`role` 和 `aria-live`，同时显示可见文字标签，不能只靠边框颜色区分结果。
- 范围边界：不提前抽取三栏、页签、编辑器、主题配置或万能页面 hook；候选 `PathStatus`、`DesktopWindowStatus`、`RecentWorkspaceList` 只有出现第二个同职责消费者时才进入公共层。

## 功能开发的实际结果

- `AppDialog` 增加显式焦点入口和键盘圈定。真实 `showModal()` 仍是原生模态事实源，公共组件补齐 WebView/测试回退以及无可聚焦控件的稳定行为。
- `AsyncStatePanel` 改为强制传入类型化 `state`；根应用、P1、P2 全部迁移，不再由页面分别传 `tone` 和 `live` 组合。组件支持单状态或同一区域候选状态集合，并按固定优先级选择主状态。
- 状态面板新增可见中文标签，例如“正在处理”“操作失败”“位置失效”“需要授权”，并自动使用 polite status 或 assertive alert。
- 对话框阴影和模态遮罩从组件私有 `rgb(...)` 提升为 `--shadow-dialog`、`--color-dialog-backdrop` 全局语义 token，保持原视觉值不变；P1/P2 样式中重复导入公共组件 CSS 的语句已删除，由组件自己负责加载。
- P1/P2 继续真实复用 `AppDialog`、`AsyncStatePanel`；`PathStatus`、`DesktopWindowStatus` 与 `RecentWorkspaceList` 经代码对照后未创建，因为活动文档路径、最近目录路径和窗口恢复项的职责/结构不同，且没有第二个同职责消费者。
- 完整回归第一次暴露 `WorkspaceTree` 在异步扫描节点刚出现、effect 尚未提交时可能短暂让所有 treeitem 都为 `tabIndex=-1`。现以 `effectiveRovingPath` 在渲染期选择当前有效项、选中项或首项，既消除测试竞态，也保证可见树始终存在一个 Tab 停靠点。
- 阶段计划、需求映射状态、`DESIGN.md` 组件清单/状态优先级和 `AGENTS.md` 当前事实已同步；T15 仍是下一任务，本次未连续开发。

## 功能开发的具体实施方案

### 公共对话框

- `focusDialogEntry` 仅在对话框已打开且焦点尚未位于内部时执行，优先 `[autofocus]`、再取首个可交互控件，最后回退到带 `tabIndex=-1` 的 dialog 本体。
- `focusableElements` 只收集未禁用、未隐藏且未标记 `aria-hidden=true` 的按钮、链接、输入和显式 Tab 项。
- Tab 到末项回首项，Shift+Tab 在首项回末项；没有交互控件时阻止焦点逃逸并保持 dialog 聚焦。
- 关闭恢复先确认触发器仍 `isConnected`，避免页面切换或节点删除后对失效 DOM 调用 focus。

### 类型化状态契约

- 公共状态枚举覆盖 `ready/loading/empty/error/readonly/dirty/saving/conflict/missing/permission_denied/unsupported`。
- `resolveAsyncState` 对单状态和状态集合使用同一优先级表，空集合安全回退 `ready`；权限与位置类阻塞使用 assertive alert，普通进度与稳定状态使用 polite status。
- `data-state` 保留领域状态，`data-tone` 只作为样式派生结果；页面不能通过颜色参数覆盖领域优先级。
- 可见状态标签使用现有 `success/warning/danger/muted` token；标题和说明继续承担对象与恢复方式，颜色不成为唯一信息通道。

### 复用判断

- 已查找同类实现：P1/P2 所有 `AppDialog`/`AsyncStatePanel` 消费点、T8 `PermanentDeleteDialog`、根应用 bootstrap、最近工作区行、工作台标题/状态栏、恢复列表和 `WorkspaceTree` 键盘模型。
- 已复用/固化：`AppDialog` 负责所有模态焦点与关闭边界；`AsyncStatePanel` 负责跨页面持久状态；`DESIGN.md` token 负责颜色、遮罩和阴影。
- 未抽取 `PathStatus`：P1 显示活动文档/选择/根路径，P2 显示最近根及可用性，数据来源、布局、操作和生命周期不同；强行共享需要页面 variant，尚不构成稳定职责。
- 未抽取 `DesktopWindowStatus`：P1 窗口身份由标题与 Rust 协调器驱动，P2 恢复项是批处理状态；没有第二个独立窗口状态控件消费者。
- 未抽取 `RecentWorkspaceList`：当前只有 P2 消费最近记录；列表仍是 `WorkspaceLauncher` 内部实现，后续出现第二个同职责页面再评估。
- 同步维护：计划 §3/§4/§5/§6.14/§8、`DESIGN.md` 组件登记与状态规则、`AGENTS.md` 当前阶段和测试计数。

## 上线部署操作

- 本次无 SQL、seed、数据库、状态 schema、远端服务、账号、环境变量、系统菜单、Tauri capability 或初始化数据变更。
- 新增 token 位于 `src/styles/tokens.css`，应用启动时随现有前端样式载入；影响仅为公共对话框继续使用原有遮罩和阴影值。
- 回滚需同时回退公共组件 API、P1/P2/根应用的 `state` 消费、组件测试和两个语义 token；不涉及 Markdown、最近记录或根窗口会话数据回滚。
- 发布前继续使用锁定 Node 24/pnpm/Rust 和 Tauri 构建；Windows 辅助技术与系统 UI 证据仍由 T16 获取。

## 验证情况

- React：`pnpm test:ui` 32/32。新增 5 个公共组件用例，覆盖 assertive/polite 与可见状态标签、状态优先级、首项聚焦、Tab/Shift+Tab 圈定和无交互 loading 对话框；既有 P1/P2 集成用例全部通过。
- 前端状态与反馈：`pnpm test:workspace-tree` 18/18、`pnpm test:permanent-delete-feedback` 4/4、`pnpm test:licenses` 2/2。
- 生产构建：`pnpm build` 通过，TypeScript 强制所有 `AsyncStatePanel` 消费点提供类型化状态。
- Rust：`cargo test --locked --manifest-path src-tauri/Cargo.toml` 111/111，`cargo fmt --check` 与 `cargo clippy --all-targets -- -D warnings` 通过；T14 没有修改 Rust 行为。
- 许可证：显式加载 Cargo 环境后扫描 112 个 Node 包、487 个 Rust 包，0 个阻断项。
- 浏览器：P2 在 1100×720 为双栏、740×720 为打开入口优先单列；两档均 `scrollWidth === innerWidth`。根启动失败和点击“打开文件夹”后的 launcher 失败均显示可见“操作失败”标签与 alert 语义；点击“关闭”后对应持久错误面板真实移除。
- 验证过程披露：第一次全量 React 回归发现文件树 roving tabindex 的渲染期竞态，修正组件不变式后 32/32 通过。一次组合前端命令因非交互 shell 未加载 Cargo，在许可证清单处以 `spawnSync cargo ENOENT` 退出，后续生产构建未执行；显式加载既有 Cargo 环境后许可证与生产构建均重新执行并通过。
- Tauri release：`pnpm tauri build --no-bundle` 通过，验证公共组件与 token 能进入正式桌面构建。
- 未执行：稳定 WDIO、Windows 编译/辅助技术、P1 本轮真实 IPC 视觉、系统废纸篓/Finder、watch/safe-write 长时链路和双进程转发。P1 浏览器入口依赖真实 Tauri 当前窗口快照，本轮没有注入假工作区绕过门控；上述项继续由 T15/T16 承接，不外推为通过。
