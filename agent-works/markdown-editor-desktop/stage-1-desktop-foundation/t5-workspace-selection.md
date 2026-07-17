# T5 系统选择与工作区授权开发记录

## 范围与状态

- 任务：第一阶段 T5，承接 R1 的真实系统选择器/本地授权底座、R14 的同根识别与最近记录复检，以及 P2 7.2.1 的命令数据源。
- 状态：已完成。
- 本任务不创建 P1/P2 页面，不启用“打开”菜单，不创建工作区窗口，不扫描文件树；T11/T12 接入真实消费者前不得把命令存在表述为完整打开流程。
- 本任务不涉及数据库、SQL、seed、打开方式偏好或 Markdown 写入。

## 权限与提交边界

- 系统选择器由 Rust command 通过 `tauri-plugin-dialog` 发起；TypeScript 只能调用无路径参数的选择命令，不能提交绝对路径冒充用户授权。
- `src-tauri/capabilities/default.json` 未变化，仍只有 `core:default`；没有前端 Dialog、FS、Store、Shell 或 HOME 权限。
- 选择器取消返回 `cancelled`，不创建待确认项、不登记工作区、不写最近记录。
- 普通目录返回 `ready`；单文件和符号链接根返回 `confirmation_required`。单文件只接受大小写不敏感的 `.md`，以父目录为根，提案同时提供 selected/canonical root、初始相对文件和确认原因。
- 待确认项只保存在进程内，使用操作系统随机生成的 128-bit 一次性令牌；10 分钟过期、最多 32 项，超限淘汰最旧项。授权时重新检查磁盘、扩展名、链接和 canonical identity，选择后换靶不得通过。
- 授权成功只登记进程内 `WorkspaceRegistry`。最近记录必须由 T11 在真实窗口打开成功后调用 Rust 内部 `record_workspace_opened` 提交；窗口失败时调用 `release_workspace`，避免假成功和重复目录锁死。
- `confirmed` 是可信本地前端对用户已完成确认交互的 UX 回执，不是 Rust 安全授权边界；Rust 始终独立执行令牌校验、路径重解析、canonical identity 比对、扩展名与链接边界检查。CSP 或前端可信前提变化时必须重新评估该接口。
- 选择后若普通目录被替换为指向同一 canonical 目标的符号链接，仍允许授权，因为实际授权范围没有变化；若目标不同则 identity 比对失败。该兼容行为不得扩展为允许根内链接越界。

## 数据契约

- `WorkspaceSelectionOutcome`：`cancelled`、`already_open`、`ready`、`confirmation_required`；Rust 固定序列化测试锁定 tag、`already_open.workspaceId/initialFile` 和 `proposal` 外层字段，并与 TypeScript 状态常量对照。
- `WorkspaceSelectionKind`：`folder`、`markdown_file`，Rust 序列化值与 TypeScript `WORKSPACE_SELECTION_KINDS` 全量对照。
- `WorkspaceSelectionProposal`：选择令牌、类型、展示路径、规范化根、初始相对文件、链接/父目录确认状态。
- 工作区 ID：`workspace-v1-` + canonical identity 的 SHA-256 前 128 bit；Windows identity 已统一扩展前缀、分隔符和大小写，同一根跨会话得到稳定 ID。
- 初始 `writable` 在 POSIX 使用权限位作为提示；Windows 目录 readonly 属性不代表 ACL，因此不据此判只读。后续每个真实文件命令的磁盘结果才是写权限事实源。
- 最近记录复检只接收 `workspaceId`，从 T4 状态仓储读取已保存路径并重新校验；前端不能传历史绝对路径。记录不存在、路径失效、权限失效和状态 ID/路径不一致均返回稳定错误。
- 新增 6 个错误码：`dialog_unavailable`、`unsupported_markdown_file`、`selection_not_found`、`selection_unavailable`、`selection_confirmation_required`、`recent_workspace_not_found`；Rust 与 TypeScript parity 测试覆盖全集。

## 命令与前端封装

- Rust commands：`select_workspace_folder`、`select_markdown_file`、`authorize_workspace_selection`、`cancel_workspace_selection`、`validate_recent_workspace`。
- TypeScript 统一封装：`src/services/desktop/workspace.ts`，页面不得复制 command 字符串或绕过返回类型。
- 菜单“打开文件夹/打开 Markdown”继续禁用：T5 尚无父目录确认对话框和窗口协调消费者，启用只会产生不可完成或虚假流程；T11/T12 接入后再同步启用。

## 依赖、配置与回滚

- `tauri-plugin-dialog = 2.7.1`：官方跨平台系统选择器；只由 Rust 使用。
- `sha2 = 0.10.9`：稳定工作区 ID；`getrandom = 0.3.4`：不可预测的选择授权令牌；二者均已存在于锁文件依赖图，本次转为直接依赖。
- Dialog 插件新增 14 个锁定 Rust 包；全量许可证扫描为 29 个 Node 包、431 个 Rust 包、0 个阻断项。
- 回滚：回退 T5 代码、Cargo/TS 契约和锁文件即可；未修改 capability、Markdown 或数据库。若已由后续任务写入最近记录，T4 schema 仍可读取，不依赖 Dialog 插件。

## 验证证据

- `cargo test --locked --manifest-path src-tauri/Cargo.toml`：44 个单元测试通过。
- `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`：通过。
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`、`cargo check --locked`：通过。
- `pnpm build`：通过，TypeScript 命令封装与选择契约纳入严格类型检查。
- `pnpm test:licenses`：2/2；`pnpm licenses:check`：29/431/0。
- 覆盖：取消零副作用、父目录确认、扩展名和链接拒绝、一次性消费、令牌缺失/过期/上限、链接换靶、选择枚举/tagged union 契约、稳定 ID、同根识别、打开失败释放、最近记录提交更新、路径失效复检与 POSIX 只读提示。
- 复审整改的第一次完整回归因 TypeScript 常量写成单行而被契约解析器拒绝；改为逐行常量后该用例通过。第二次完整回归暴露既有 T4 状态测试临时目录的快速重跑碰撞，补原子序号后第三次完整回归全部通过。两次中间失败均未作为通过证据。

## 未验证

- macOS 原生选择器 UI 未取得独立通过证据：测试线程被 rfd 拒绝为非主线程环境；一次性 debug 主循环与临时真实按钮入口均未得到可复现面板回调，且当前自动化进程没有辅助访问授权。所有临时代码已移除，T12 接入正式入口后由 T15 执行 macOS 冒烟。
- Windows Dialog 插件、选择器过滤/取消和 T4 原子替换分支尚未编译或实测，必须由 T16 Windows runner 验证。
- 没有页面、菜单点击、窗口创建、最近列表和重新授权 UI 验证；对应消费者属于 T11/T12，不外推为通过。
