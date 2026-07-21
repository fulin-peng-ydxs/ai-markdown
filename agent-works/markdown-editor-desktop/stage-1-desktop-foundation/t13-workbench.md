# T13 工作台壳与真实文件树开发记录

## 功能的详细需求

- 任务：第一阶段 T13，承接 P1 的 7.1.1、7.1.3、7.1.7，以及 R1、R2、R8、R11、R14、R30、R31 在工作台壳范围内的子集。
- 入口：当前原生窗口已绑定工作区时，由根应用进入 P1；P2 在当前窗口成功打开工作区后也切换到 P1。
- 主任务：查看授权根内的渐进文件树，读取真实 Markdown，执行受控新建、重命名、移动、删除和系统定位，并在当前窗口或新窗口打开其他目录。
- 数据边界：当前窗口与工作区绑定来自 Rust 窗口协调器；目录、文件内容、监听批次和磁盘操作只来自受授权根约束的 Rust command。前端不接收通用文件系统权限，也不根据路径文本自行宣称成功。
- 提交边界：文件树只在磁盘操作成功后更新；失败时保留最后安全树和当前文档。打开其他根必须经过授权确认和窗口三选，取消或失败不能破坏原窗口。
- 页面状态：覆盖 loading、empty、ready、error、readonly、unsupported encoding、too large、missing、permission-denied、watch failed 和 mutation processing/failed；错误必须说明磁盘内容是否安全。
- 当前阶段边界：中央区只提供真实只读 Markdown；不创建假编辑器、假页签、假大纲、假搜索或自动保存。完整 R1、R2、R5、R8、R14、R30、R31 仍需后续阶段与跨平台证据。

## 功能开发的实际结果

- 根应用新增当前窗口工作区快照路由：有真实绑定时渲染 `WorkspaceWorkbench`，无绑定或恢复失败时保留 P2 启动页和持久错误，不用最近记录反推当前工作区。
- 新增 `WorkspaceWorkbench`、`WorkspaceTree` 和可注入 workbench gateway，接通扫描/轮询、读取、监听、CRUD、回收站、永久删除、系统定位、选择授权、窗口协调、标题和菜单事件。
- 文件树支持目录优先和中文名称排序、懒加载、外部变化 reconcile、只读标识、选中状态及键盘树语义。复核整改后采用 roving tabindex，只保留一个 Tab 停靠点，并补齐上下项、首尾项、展开目录首子项和返回父项导航。
- 文件操作均先等待 Rust 磁盘成功结果，再提交树状态；创建失败、过期扫描和旧 workspace generation 不覆盖最后安全状态。同目录 watch 重扫在前端按“一个在途 + 最多一个待执行 reconcile”串行归并，避免并发轮询空转且不丢最后一次外部变化。
- 页面错误只在存在真实恢复动作时显示“重试”：扫描、监听、标题和系统定位分别重做对应动作；无法安全重建上下文的错误只提供关闭，不再展示清除错误但不执行操作的按钮。
- P1 复用 T12 的 `AppDialog` 和 `AsyncStatePanel`，永久删除继续复用 T8 对话框；没有为工作台复制第二套 modal、异步状态或桌面错误体系。
- 宽窗口采用 252px 文件侧区和中央文档区；不超过 820px 时文件树退化为抽屉，Esc、遮罩和关闭按钮退出后将焦点返回触发器。样式只消费 `DESIGN.md` 语义 token。
- 新增窗口工作区快照、受控标题命令和 Rust↔TypeScript parity；标题按“工作区 — 文件 — Plainroot”生成，相对路径仍经 Rust 领域类型校验。
- 复核指出的任务级留痕缺失已由本文补齐；P2～P4 的无障碍、重试语义和重扫效率问题已同步代码、组件测试、计划与设计事实源。

## 功能开发的具体实施方案

### 窗口、工作区与内容链路

- `get_workspace_workbench_snapshot` 根据当前窗口标签读取协调器绑定，再从授权服务取得工作区描述；未绑定返回空快照，避免把最近目录误当当前窗口。
- `App.tsx` 负责 bootstrap、恢复错误和 P1/P2 路由。P2 只有收到 `opened_current` 才回调切换当前窗口；`opened_new` 保持原窗口不变。
- `set_workbench_window_title` 只接受可选工作区相对路径，复用 `WorkspaceRelativePath::parse` 与现有标题生成规则；标题失败不影响文件内容或磁盘状态。
- 选择树中 Markdown 后进入 loading，再消费 `read_markdown_file` 的 ready/unsupported/too-large 结果；读取失败只更新文档错误态，不伪造旧内容。

### 文件树、监听与磁盘提交

- 初次进入工作区启动根扫描；展开未加载目录时按需扫描。每个 scanId 只提交匹配当前 generation 和当前 reducer 记录的批次，切换工作区会取消旧扫描和 watcher。
- watcher 批次先进入既有 `WorkspaceTreeState`，再对 `rescanDirectories` 发起 reconcile。相同 generation 与目录只允许一个扫描在途；期间收到的重复 reconcile 合并为一次后继扫描。
- 新建、重命名、移动、回收站和永久删除沿用 T7/T8 命令与 mutationId 守卫。磁盘失败进入 processing/failed 状态并保留旧路径；成功后才新增、重映射或删除节点。
- 重命名和移动会同步重映射选择、展开路径和当前打开文档；删除目录时只有当前文档位于目标内才清空中央区，单纯选中目录不会误关其他文档。

### 键盘、焦点与响应式

- `WorkspaceTree` 维护可见节点的 roving path：只有当前 roving 节点 `tabIndex=0`，其他节点为 `-1`。上下方向键移动相邻可见项，Home/End 到首尾，右键展开或进入首子项，左键折叠或返回父项。
- 鼠标点击与 DOM focus 会同步 roving path；节点因折叠、重命名或删除不再可见时，回退到仍可见的已选项或首项。
- 文件抽屉关闭统一回到标题栏触发器；对话框继续消费 `AppDialog` 的 Esc、遮罩、关闭门禁和焦点返回契约。
- 1180px、1050px 与 820px 原始 T13 证据验证了主区、滚动和抽屉；本轮浏览器回归验证无 Tauri IPC 时仍安全回落 P2，1280px 无水平溢出。浏览器无法绕过真实窗口快照直接渲染 P1，因此不把该回归冒充工作台视觉证据。

### 复用判断

- 已查找同类实现：T12 `WorkspaceLauncher`、共享 `AppDialog`/`AsyncStatePanel`、T8 `PermanentDeleteDialog`、既有 `WorkspaceTreeState`、desktop gateway 与错误映射。
- 已复用：公共对话框、异步状态面板、永久删除流程、树 reducer、受控桌面 adapter、错误码与语义 token。
- 本次新增复用单元：workbench gateway 作为页面与真实 Tauri adapter 的稳定测试边界；当前只有 P1 消费，不上移为跨页面万能 gateway。
- 未抽取：P1 与 P2 的页面编排虽然都包含打开工作区，但生命周期、页面状态和恢复上下文不同；T14 已排期基于两个真实消费者检查可稳定复用部分，本任务不提前制造大而全 hook。
- 同步维护：`DESIGN.md` 组件登记、阶段 `plan.md` 的 T13 实际结果/验证计数，以及 `AGENTS.md` 当前测试事实。

## 上线部署操作

- 本次无 SQL、seed、数据库迁移、账号、远端权限、环境变量、定时任务或第三方平台配置。
- 桌面命令继续通过 `src-tauri/src/lib.rs` 注册，capability 保持最小 `core:default`，没有新增前端通用文件系统、Dialog、Shell、Store、HOME 或网络权限。
- 发布前需用锁定 Node 24/pnpm/Rust 执行前端、Rust、许可证与 Tauri 构建；Windows 分支由 T16 的真实 runner 编译和验证。
- 回滚需同时回退 P1 页面、两个桌面命令、TypeScript 契约和根应用路由；辅助状态 schema 与 Markdown 无迁移，不执行用户文件数据回滚。

## 验证情况

- React：原始 T13 为 23/23；复核整改后 `pnpm test:ui` 为 27/27。新增或加强 roving tabindex、上下项、展开目录首子项/返回父项、无真实动作时隐藏重试、定位失败后实际重试和同目录 watch 重扫串行归并测试。
- 既有前端：`pnpm test:workspace-tree` 18/18、`pnpm test:permanent-delete-feedback` 4/4、许可证策略 2/2；生产 `pnpm build` 通过。
- Rust：T13 全量 `cargo test --locked --manifest-path src-tauri/Cargo.toml` 111/111，含 workbench snapshot parity 和窗口标题错误码同步；`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings` 通过。
- 许可证：112 个 Node 包、487 个 Rust 包、0 个阻断项。
- 构建：复核整改后重新执行 `pnpm build` 与 `pnpm tauri build --no-bundle`，均通过并生成 release 可执行文件；原始 T13 的 macOS `.app` 也已构建并启动。
- macOS 实机：使用临时目录验证系统选择器、真实 Markdown 读取、UI 新建后磁盘存在、新窗口打开且原窗口保持；测试目录与会话记录已清理。
- 浏览器：原始 T13 通过临时可视化夹具核验 1180/1050/820px 与抽屉焦点，夹具未进入版本库；复核整改后真实浏览器入口在无 Tauri IPC 时回落 P2，1280px `scrollWidth === innerWidth`。该浏览器结果不证明 P1 IPC 或视觉。
- 验证过程披露：复核整改首次完整回归的非交互 shell 未加载 Cargo，前端 27/27、18/18、4/4、2/2 已通过，但许可证清单以 `spawnSync cargo ENOENT`、Rust 命令以 `cargo: command not found` 退出，且前端生产构建因命令链短路未执行。显式加载既有 nvm 与 Cargo 环境后，许可证、生产构建、Rust 111/111、fmt、clippy 和 Tauri release 构建均重新执行并通过。
- 未执行：稳定 Tauri WDIO、Windows 编译/系统 UI、真实系统废纸篓/Finder、watch 与 safe-write 长时产品级链路、双进程 single-instance 转发。它们分别由 T15/T16 承接，当前不得外推为通过。
