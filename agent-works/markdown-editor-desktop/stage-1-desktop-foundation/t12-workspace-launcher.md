# T12 工作区启动页与最近目录开发记录

## 功能的详细需求

- 任务：第一阶段 T12，承接 P2 的 7.2.1～7.2.3，以及 R1、R8、R11、R14、R30、R31 在启动页范围内的子集。
- 入口：首次启动、新建空窗口、无活动工作区、根窗口恢复失败，以及原生“打开文件夹/打开 Markdown 文件”菜单与对应快捷键。
- 页面状态：ready、loading、empty、filtered-empty、error、missing、permission-denied 和 partial restore。错误必须保留在页面或对话框中，并提供真实重试、关闭、跳过或重新授权操作。
- 数据边界：最近记录与根会话只来自 T4 版本化状态仓储；本地范围只由 T5 Rust 选择/授权管线建立；窗口结果只消费 T11 协调器。前端不提交任意绝对路径，也不使用原型假数据、固定计时器或假成功 Toast。
- 提交边界：取消系统选择器不写状态；打开成功后才由窗口协调器写最近记录和根会话；移除只删除辅助记录与恢复意图，不删除目录或 Markdown；单文件必须显示父目录授权范围。
- 页面边界：不渲染无设置页的设置按钮；不提前实现 P1 文件树、编辑器或页签；根恢复不宣称恢复页签、光标或锚点。
- 第二实例边界：T11 的启动参数只进入有界队列；T12 不把外部参数直接升级为授权路径，队列消费、路径重新确认和双进程验证留给 T15。

## 功能开发的实际结果

- 新增 P2 `WorkspaceLauncher`，实现真实打开入口、最近列表、名称/路径过滤、可点击清除、空态、持久错误、失效记录、重新授权、安全移除、窗口三选与根会话恢复列表。
- 新增共享 `AppDialog` 与 `AsyncStatePanel`。前者统一 modal、Esc/遮罩关闭、关闭门禁、焦点返回和动作区，并兼容不提供原生 `showModal/close` 的 WebView；永久删除对话框已改为复用该组件。后者承接持久状态与 aria-live。
- 新增统一桌面错误转换与 P2 可注入 gateway；四类窗口错误均映射到明确文案、关闭和真实重试，不再停留在菜单 stderr。
- Rust 新增 launcher snapshot、最近记录移除、根恢复会话移除和最近项 availability 回写；snapshot 同时提供当前窗口、活跃 workspaceId 与根会话，避免对已活动工作区重复恢复。
- 原生打开菜单在 P2 消费链路落地后启用，通过 Tauri 事件发送给聚焦窗口；编辑、搜索和帮助等未实现项继续禁用。
- 窗口标签分配在协调锁内预留，创建失败释放；恢复会话移除的状态 I/O 不再长时间持有协调锁。移除活跃工作区的辅助恢复记录时保留当前内存授权与窗口映射，不修改 Markdown。

## 功能开发的具体实施方案

### 启动状态与 IPC

- `get_workspace_launcher_snapshot` 一次读取最近记录、根会话、活跃工作区、当前窗口工作区和窗口标签；Rust↔TypeScript 字段由 parity 测试锁定。
- 系统选择器继续由 Rust command 发起。普通目录可直接授权；单文件和符号链接根先返回 proposal，由 `AppDialog` 展示 selected/canonical 范围后再提交一次性令牌。
- `coordinateWorkspaceOpen` 继续消费 T11 的 `decision_required/opened_current/opened_new/focused_existing/cancelled`。当前窗口已有其他根时只显示“替换当前窗口/在新窗口打开/取消”，不保存默认偏好。
- 最近记录校验失败会区分 missing 与 permission-denied。重新授权选择新根后继续原打开流程；workspaceId 变化时才移除旧辅助记录。
- 根恢复按当前窗口标签优先、其余新窗口的顺序逐项执行。单项失败、需重新确认或最近记录缺失只更新该项状态；支持重试、跳过和移除失效会话。

### 页面、组件与响应式

- P2 使用 `paper/paper-deep/chrome/line/accent/success/warning/danger` 等语义 token；没有复制原型的私有颜色或 macOS 网页交通灯。
- 约 760px 以上为“打开本地内容 + 最近工作区”双栏，以下变为单一页面滚动，打开入口始终排在最近列表之前；1100×720 与 740×720 均验证无水平溢出。
- 最近路径和名称单行省略，失效状态同时使用文案与边界，不只依赖颜色。过滤只匹配名称和 canonical path，过滤空态提供真实“清除过滤”按钮。
- `AppDialog` 由 P2 和永久删除共同消费；`AsyncStatePanel` 由加载失败、窗口错误和已连接状态消费。`PathStatus` 尚未形成第二个真实职责，不提前创建。
- 菜单、按钮与 `Cmd/Ctrl+O`、`Cmd/Ctrl+Shift+O` 进入同一 gateway；对话框支持 Esc 与焦点返回，reduced-motion 关闭旋转动画。

### 配置、数据与回滚

- 状态：沿用 `appDataDir()/plainroot-state-v1.json` 与 schemaVersion 1，不新增字段或迁移；新增命令只读写既有 `recentWorkspaces`、`workspaceSessions`。回滚前退出应用并备份辅助状态文件即可，Markdown 无迁移。
- 菜单：`src-tauri/src/menu.rs` 启用 `file.open_folder`、`file.open_markdown` 并向聚焦窗口发送 `plainroot://launcher-menu`；回滚时需同步恢复启用表与前端监听，避免出现无消费者菜单。
- 前端测试：新增 Vitest、Testing Library 与 jsdom，配置路径为 `vitest.config.ts`，执行时机为 `pnpm test:ui`；只影响开发依赖，无运行时权限。
- capability：保持 `core:default`，未增加前端 Dialog、FS、Shell、Store、HOME、网络或数据库权限。
- 数据库、SQL、seed、账号、远端权限、环境变量和初始化业务数据：均不涉及。

## 上线部署操作

1. 使用锁定 Node/pnpm/Rust 运行 frozen install、UI/既有前端测试、Rust 全量测试、clippy、许可证门禁和 Tauri 生产构建。
2. macOS/Windows 测试包分别验证系统文件夹与 `.md` 选择器、取消、父目录授权、窗口三选、失效/权限撤销、最近记录移除不删磁盘和多根部分恢复。
3. 升级不迁移状态 schema；若辅助状态不可读，P2 必须保留打开新内容入口并显示持久错误，不能修改用户 Markdown。
4. 回滚同时回退 launcher、共享组件、三个新命令、菜单事件和 TypeScript 契约；用户目录与 Markdown 不执行数据回滚。

## 验证情况

- React：`pnpm test:ui` 14/14，通过过滤/清除、移除文案、单文件范围确认、快捷键、四类窗口错误、Esc、关闭门禁和焦点返回。
- Rust：全量 110/110，通过 launcher snapshot parity、恢复会话一次性移除、活跃工作区移除辅助历史但保留当前授权，以及 T1～T11 全部回归。
- 既有前端：工作区树 18/18、永久删除反馈 4/4、许可证策略 2/2；`pnpm build`、`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings` 均通过。
- 许可证：112 个 Node 包、487 个 Rust 包、0 个阻断项。
- 构建：`pnpm tauri build --no-bundle` 和 `pnpm tauri build --bundles app` 通过，生成当前 macOS `.app`。
- 浏览器渲染：1100×720 与 740×720 的主区、滚动和水平溢出已检查；740px 为单列，打开入口在最近列表之前。无 Tauri IPC 的浏览器环境保留启动页并显示持久错误，不伪装成功。
- macOS 实机：当前 `.app` 已验证原生菜单启用态、系统文件夹选择器取消、临时目录真实授权/打开、最近记录、过滤/清除、安全移除且 96 字节测试文件仍存在；另验证 `.md` 文件选择后展示 selected/canonical 父目录范围，取消后不新增最近记录。测试临时目录已清理。
- 验证过程披露：首次许可证盘点因非交互 shell 未加载 Cargo PATH，以 `spawnSync cargo ENOENT` 退出；加载 Rust 环境后重跑为 0 阻断。首次原生截图误连到仓库中 T11 旧 `.app`；发现菜单仍禁用后核对进程，重新构建当前 `.app` 并以唯一进程复验，最终证据均来自 T12 包。
- 未执行：Tauri WDIO 基线尚未建立，本任务未执行 WDIO；Windows 构建/系统选择器/菜单/字体与真实多根部分恢复长时场景也未执行。稳定桌面 E2E、Windows 和剩余集成分别由 T15/T16 承接，不外推为通过。
