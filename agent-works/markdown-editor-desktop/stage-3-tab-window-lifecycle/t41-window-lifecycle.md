# T41 窗口结算与工作区打开偏好

## 功能的详细需求

T41 承接 R1、R5、R14、R30 与 R31 的第三阶段子集，目标是在既有一目录一窗口和 Rust 窗口事务底座上完成两件事：

- 当前窗口替换、系统/菜单关闭窗口和应用退出必须检查当前窗口的全部页签，复用 T40 的同一两阶段结算；任一页签仍处于 dirty、saving、save_failed、readonly 或 conflict 等未解决状态时，不允许窗口事务继续。
- 工作区打开方式提供“每次询问 / 当前窗口 / 新窗口”三值偏好，P1、P2 和原生设置菜单消费同一设置弹层；偏好可显式恢复为“每次询问”，且不能绕过授权、同目录聚焦或全页签结算。

本任务不实现已有窗口页签会话的启动恢复，不新增窗口位置、尺寸或三栏布局持久化，也不接入原生页签命令；这些分别由 T42、阶段 4 和 T43 承接。

## 功能开发的实际结果

- `src-tauri/src/preferences.rs` 在现有 schema v1 中新增向后兼容的全局 `workspaceOpenDisposition`。旧文件缺失字段时默认 `ask`；读取、保存和重置复用既有私有临时文件与原子替换，写失败保持磁盘和内存旧值。
- `src-tauri/src/commands/workspace.rs`、`src-tauri/src/lib.rs` 与 `src/services/desktop/workspace.ts` 增加偏好读取、设置、重置 IPC；默认打开调用先读取偏好，读取失败安全回到询问，不阻止用户继续打开工作区。
- `src-tauri/src/menu.rs` 增加“工作区打开方式…”入口：macOS 放在应用菜单，其他桌面平台放在文件菜单，并通过既有 launcher menu event 发送给当前聚焦窗口。
- `src/features/workspace-open/` 新增 P1/P2 共用的 `WorkspaceOpenDecisionDialog` 与 `WorkspaceOpenPreferenceDialog`。决策弹层支持“记住这次选择”；偏好写失败时保留弹层且不继续打开，窗口提交失败时保留真实错误与重试入口。
- `WorkspaceWorkbench` 将 `replace_workspace`、`close_window`、`quit_app` intent 映射到 T40 的同一页签结算批次。取消显式向 Rust 提交 `allow=false`；全部页签安全后，先刷新并持久化当前内容无关页签会话，再提交 `allow=true`。最终提交失败时保留页签和结算批次，用户可重试或取消。
- `WorkspaceLauncher` 的设置图标升级为真实偏好入口；P1/P2 的当前窗口/新窗口决策共用同一组件和 gateway 契约。
- T42 尚未消费的既有非空页签会话继续处于 `deferred_existing_session`，T41 不覆盖这份可恢复元数据。

当前仍未完成：已有页签会话启动恢复、原生页签命令、第三阶段远端双平台 CI、真实双窗口替换/退出的隔离桌面 E2E，以及 Windows 原生设置菜单人工验证。因此 T41 完成不等于 R13、R14 或第三阶段完成。

## 功能开发的具体实施方案

### 偏好与打开链路

1. Rust `WorkspaceOpenPreference` 只允许 `ask/current_window/new_window`，通过 Rust/TypeScript parity 测试锁定字段和枚举值。
2. P1/P2 的 gateway 都调用 `coordinateWorkspaceOpenUsingPreference`；调用方显式传入打开位置时不再读取默认值，未传入时才读取偏好。
3. 偏好读取失败回到 `ask`，仍由既有 Rust coordinator 返回 `decision_required`；同目录打开仍聚焦已有窗口，不创建第二个可写映射。
4. 用户在决策弹层勾选“记住这次选择”时先持久化偏好，再发起窗口协调；偏好写失败不静默继续。

### 全页签窗口结算

1. Rust 继续产生一次性窗口 settlement intent，前端不另建窗口事务协调器。
2. P1 将 intent 的 kind 映射为 `replace_workspace/close_window/quit_app` 结算原因，并以当前 ordered tab IDs 创建 T40 的不可变目标批次。
3. 批次逐项复用现有 `DocumentSaveController`、冲突和另存能力；最终动作继续绑定页签 incarnation、generation 与 editVersion。
4. 用户取消时清理页面 busy/closing 状态并拒绝 Rust intent；用户提交时先确认批次仍安全、持久化页签元数据，再允许 Rust 完成窗口事务。
5. 提交阶段失败不清空批次、不移除页签，也不宣称已经回滚真实成功的磁盘保存。

### 复用判断

- P1 与 P2 第二次出现同职责的打开位置决策和偏好设置后，抽取 `src/features/workspace-open/`，共同消费 `AppDialog`、`plainroot-button` 和语义 token；没有保留页面私有弹层副本。
- 窗口替换、关闭、退出直接消费 T40 的 `TabSettlementDialog`、`settleTabs` 与固定目标证据，不建立第二套保存检查。
- 全局打开偏好与资源目录偏好共用 `PreferencesRepository` 的版本化原子仓储；没有新增 Store、数据库或第二个配置文件。
- P1/P2 gateway 的命令集合不同，保留各自薄接口；共享的 UI gateway 只抽取到 `WorkspaceOpenPreferenceGateway`，避免为两个页面制造带大量可选字段的通用 gateway。

最终实现与 T41 计划一致。唯一验证边界是：本任务运行了现有 11 条 macOS 真桌面回归证明无回退，但没有新增覆盖真实双窗口 replace/quit 的 E2E；该增量覆盖仍按计划归入 T45。

## 上线部署操作

- 本次无数据库、SQL、seed、账号、第三方服务、产品环境变量或依赖变更。
- 本次无 capability 变更；正式前端仍只使用现有 Tauri command/event 边界。
- 本地配置仍为 `appDataDir()/plainroot-preferences-v1.json`。新字段为向后兼容可选字段，旧文件无需迁移；删除该文件会安全恢复为“每次询问”和默认资源目录，不删除 Markdown、图片或窗口会话。
- 菜单随桌面应用构建生效，无独立部署脚本。回滚该功能时需同时移除菜单项、Rust commands、TypeScript contract 和 P1/P2 消费入口，不能留下悬空 accelerator 或不可消费事件。

## 验证情况

本次实际执行并通过：

- `pnpm test:ui`：32 个文件、254 项通过。
- `pnpm test:tabs`：8 个文件、63 项通过。
- Rust 非桌面服务门禁：201 项通过，1 项手动性能探针忽略。
- Node 独立回归：许可证策略 4/4、永久删除反馈 4/4、工作区路径 3/3、文件树 18/18、fixture 1/1，共 30/30。
- `pnpm typecheck`、`pnpm build` 通过；Vite 仍报告既有源码 editor chunk 超过 500 kB 的告警。
- `cargo fmt --check`、全 targets/all features `cargo clippy -D warnings` 通过。
- 许可证扫描：727 个 Node 包、511 个 Rust 包、0 个阻断项。
- `pnpm test:e2e`：本机 macOS Tauri/WebKit 11/11 通过，证明既有 P1/P2、页签批量结算和真实磁盘链路未回退。
- P2 设置入口浏览器实测：1100×760 与 740×760 均无根级横向溢出；偏好弹层在视口内，取消后焦点返回“设置工作区打开方式”触发器。

本次未执行或未取得：

- Windows 编译、WebView2 E2E 和原生菜单人工验证。
- 第三阶段最新提交的远端 CI。
- T41 新增真实双窗口替换、整组退出与原生设置菜单的隔离桌面 E2E；由 T45 补齐。
- 已有非空会话启动恢复；功能尚未实现，归 T42。
- 系统 IME、JS heap、长时峰值内存和其他既有原生系统人工项；不能由本次 macOS 自动化外推。
