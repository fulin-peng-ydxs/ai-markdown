# T37 每页签 DocumentSession / SaveController 管理器开发留痕

## 1. 任务与范围

- 任务：T37 每页签 `DocumentSession` / `DocumentSaveController` 管理器。
- 需求承接：R2、R3、R5、R6、R10、R13 的第三阶段子集。
- 计划事实源：`plan.md` §4.1～4.4、§6.3。
- 本次完成：
  - P1 内部从单一文档会话升级为多个独立页签 runtime；
  - 文件树打开 Markdown 时按 Rust 返回的平台路径身份唯一打开或聚焦；
  - 每个已加载 runtime 独立保留内容、统一 history、模式、选择、锚点、保存与恢复状态；
  - 只挂载活动页签的 Milkdown 或 CodeMirror adapter；
  - 窗口结算 intent 对全部已加载 controller 执行基础安全结算；
  - 建立真实 Tauri/WebKit 三文档切换与进程 RSS 门禁。
- 明确未完成：可见页签条、拖动/排序、关闭/最近关闭入口、持久会话恢复、跨全部页签的路径重映射、混合阻塞结算对话框和两阶段批量提交。它们仍由 T38～T42 及后续任务承接。

## 2. 实际实现

### 2.1 页签 runtime 与路径身份

- 新增 `src/features/tabs/WorkspaceTabManager.ts`：
  - 继续复用 T35 的内容无关 `WorkspaceTabCollection`；
  - runtime map 以 `tabId` 索引，每项同时绑定当前 incarnation、`DocumentSessionState` 和独立 `DocumentSaveController`；
  - 打开前调用 T36 `resolve_workspace_tab_path`，只消费 Rust 返回的规范化相对路径和 workspace 绑定 opaque identity；
  - 同一 identity 命中时聚焦既有 runtime，不再次读取磁盘或创建第二份可写会话；
  - 读取完成同时校验 tabId、incarnation 和 generation，关闭后重开或慢请求晚到都不能污染新页签；
  - 切换前通过 P1 注入的 `captureActiveProjection` 提交活动 adapter 的 Markdown、选择和锚点；
  - `settleAll` 先复用同一 `captureActiveProjection` 提交活动 adapter 的最终选择与锚点，再逐项结算全部已加载 controller；任一阻塞即保留集合。
- 新增 `src/features/tabs/tabSessionGateway.ts`，只组合既有 read、save、recovery、Remark parser 与 T36 path identity gateway，不复制磁盘协议或路径算法。

### 2.2 P1 集成

- `WorkspaceWorkbench` 为当前根工作区创建唯一 manager，并订阅其活动投影：
  - 中央文档、文件树选择、状态栏、窗口标题和原生菜单继续只消费活动 runtime；
  - 文件树点击不同 Markdown 不再销毁前一 session，返回时保留其内容、history、模式和视图；树选中项只在 Rust 路径身份解析成功后提交，失败时保留原选择与活动文档；
  - 活动 editor 以 `tabId:incarnation` 为 React key，非活动 runtime 不渲染 editor；
  - 非活动 dirty runtime 的 controller 保持存活，继续执行自动保存和恢复快照；
  - 慢读取只更新对应 runtime，且只有仍为活动路径时才能更新窗口标题；
  - 冲突重载与恢复副本先读取目标文档的最新磁盘基线；恢复命中已有 dirty runtime 时先执行内容保护；
  - 系统关闭、菜单关闭、根替换和退出的既有 settlement intent 改为遍历 manager 全部 runtime。
- T40 尚未提供逐项阻塞决策，因此当前 `settleAll` 只是底层安全门禁；不能据此宣称批量关闭、替换或完整 R5/R14 已完成。

### 2.3 单一真实 editor adapter

- `DocumentEditorShell` handle 新增 `commitProjection()`，从当前实际 adapter 读取 Markdown、选择和锚点后回写统一 session。
- `VisualMarkdownEditor` 与 `SourceMarkdownEditor` 共同消费 `EditorAdapterLifecycleEvent`：
  - 事件只在真实 `MilkdownVisualAdapter` / `CodeMirrorSourceAdapter` 创建和销毁时发出；
  - manager 记录 mounts、unmounts、活动数量、峰值和违规次数；
  - 两种 adapter 的生命周期测试及 P1 三 session 测试均锁定峰值为 1。
- 该抽取属于已有两种 adapter 的同一变化原因，未新增第二套 editor 或 history。

### 2.4 真实运行时内存门禁

- E2E feature 新增可选 `sysinfo 0.36.1`，仅测试构建注册 `e2e_process_rss_bytes`：
  - 命令不接收路径、正文或用户参数，只返回当前测试进程 RSS；
  - 默认依赖和生产命令表不注册该命令；
  - 未修改产品 capability、菜单、应用数据 schema 或环境变量。
- `desktop-shell.e2e.mjs` 新增第 10 条用例：
  - 在隔离 fixture 中加载三个 Markdown session；
  - 进行 12 轮、共 36 次真实文件树切换；
  - 每次断言 DOM 中 `.ProseMirror, .cm-editor` 总数严格为 1；
  - RSS 增量阈值为 128 MiB；
  - 若 WebKit 暴露 JS heap 则执行 64 MiB 增量门禁；当前 macOS WebKit 返回 `null`，因此只如实取得 RSS 证据。
- 最终样本：RSS `77,807,616 → 75,710,464` 字节，增量 `-2,097,152` 字节；该短时本机样本不构成 Windows、长时或 JS heap 容量承诺。
- T38 前置按实际证据解释为“单一真实 adapter + 当前平台可观测的可失败 RSS 门禁”；JS heap 在当前 WebKit 不可观测，明确留给 T45 在可观测平台补证，不得把缺失指标写成已通过，也不因此阻塞 T38。

## 3. 复用判断

- 已复用：
  - T35 `tabReducer`、`tabTypes`、`tabPath` 和公共 async state 契约；
  - T36 Rust 路径身份 IPC 与 TypeScript gateway；
  - 第二阶段 `DocumentSession`、统一 history、`DocumentSaveController`、save/recovery/assets gateway；
  - P1 现有 `DocumentEditorShell`、状态栏、菜单投影和窗口 settlement intent。
- 新增 `WorkspaceTabManager` 的理由：多 runtime 生命周期、身份索引、活动投影、后台保存和整体释放是新的稳定职责，不能继续堆入页面或单文档 session。
- 新增 adapter lifecycle 事件的理由：Milkdown 与 CodeMirror 已是第二个同职责消费者，必须共享同一计数契约，不能各写测试私有回调。
- 未抽取新页面组件：T37 没有新增可见页签 UI；T38 才建立页签栏及其视觉/键盘组件。

## 4. 异常与安全边界

- 前端不自行规范化路径、lower-case 或信任路径文本；路径唯一性仍由 Rust 平台身份决定。
- 慢读取、旧 incarnation 和陈旧 generation 不能替换当前活动文档。
- 活动 editor 的晚到标题结果不能覆盖后来活动页签标题。
- manager 销毁前先结算全部 controller；阻塞时不清空 runtime。
- 恢复副本不会直接覆盖 `.md`；目标 runtime 有未保存内容时先保护，再重读磁盘基线并载入恢复内容。
- e2e RSS 命令通过编译 feature 隔离，不进入产品命令面。

## 5. 验证结果

| 验证 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm test` | 通过：Node 30/30、Vitest 211/211、Rust 200 通过且 1 项手动性能探针忽略 |
| manager/P1 评审整改定向 Vitest | 通过：34/34；覆盖结算前投影提交与路径解析失败保留原树选择 |
| `pnpm build` | 通过；既有源码 chunk >500 kB 警告保留 |
| `cargo build --release --locked` | 通过；release 二进制字符串检查确认不含 `e2e_process_rss_bytes` |
| Rust fmt | 通过 |
| Rust all-targets/all-features Clippy `-D warnings` | 通过 |
| `cargo check --locked --features e2e` | 通过 |
| `pnpm licenses:check` | 727 Node / 511 Rust / 0 阻断 |
| `pnpm test:e2e` | macOS Tauri/WebKit 10/10 通过；含三 session、36 次切换、单 adapter 与 RSS 门禁 |

桌面套件开发过程中曾发现两类测试隔离问题并在最终绿灯前修正：

- 新增运行时用例结束时必须恢复 `note.md` 为活动文档，否则后续串行用例会从错误文档继续；
- 一次诊断重跑遗留测试应用进程，导致后续三条用例超时；终止该测试进程后从干净环境重跑，最终 10/10 通过。该失败没有被重试机制掩盖，业务测试重试仍为 0。

## 6. 文档与配置同步

- 已同步：第三阶段 `plan.md`、总 `requirement.md` 阶段状态、`DESIGN.md` 运行时复用登记、两份架构文档、README 和 AGENTS 稳定事实。
- 本次评审整改同步：`plan.md` 的 T38 内存前置口径、本留痕、架构验证摘要与 AGENTS 测试事实。需求范围、页面设计和产品配置没有变化。
- 不需要更新：
  - SQL/seed：本任务没有数据库或初始化数据；
  - 产品权限/capability：没有新增产品文件权限或前端 capability；
  - 产品菜单：没有启用可见页签命令；
  - 产品配置/环境变量：没有新增用户偏好或生产环境变量；
  - `CLAUDE.md`：仍是稳定入口指针，没有新的长期规则；
  - HTML 原型与页面流程：T37 没有新增可见页面、弹层、布局或样式。

## 7. 未验证与后续

- 未推送，未取得 T37 最新提交的 macOS/Windows 远端 CI。
- Windows WebView2 的三 session/单 adapter/RSS 门禁未运行；macOS 结果不得外推。
- WebKit 未暴露 JS heap；多小时切换、极端大文档和峰值内存仍待 T45。
- 可见页签条、键盘/拖动/溢出由 T38 承接；本留痕不宣称用户已经具备完整多页签产品体验。
- 会话仓储恢复接线由 T42 承接；当前 runtime 不会从 T36 元数据自动恢复。
