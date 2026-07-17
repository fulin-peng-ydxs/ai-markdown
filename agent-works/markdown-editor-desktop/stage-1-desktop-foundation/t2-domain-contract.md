# T2 领域契约与路径安全记录

## 范围与状态

- 任务：第一阶段 T2，承接 R2 的领域与路径安全底座。
- 状态：已完成。
- 本任务不提供扫描、文件 CRUD、安全写、窗口命令、Tauri command 或页面；这些仍由 T3、T5～T17 承接。

## 已落地契约

- Rust 模型：`WorkspaceDescriptor`、`WorkspaceRootResolution`、`FsEntry`、`FileRevision`、`RecentWorkspace`、`WorkspaceSessionRoot` 与 `DesktopError`。
- 前端镜像：`src/services/desktop/contracts.ts`，字段使用 camelCase，枚举值使用 snake_case。
- 安全入口：`WorkspaceId` 和 `WorkspaceRelativePath` 在构造及反序列化时统一校验；拒绝父级、绝对路径、Windows drive/UNC 注入及 NTFS ADS 冒号；工作区描述符只能由已检查的根解析结果建立。
- 注册边界：`WorkspaceRegistry` 只接受已构造描述符；后续前端文件命令必须提交已登记 `workspaceId + relativePath`，由 Rust 重新解析实际路径。
- 链接规则：所选根本身是符号链接时保留 selected path、展示 canonical root 并要求确认；根内链接默认不跟随，链接越界与循环均拒绝；链接根和真实根按 canonical identity 去重。
- Windows 身份键：移除 `\\?\` / `\\?\UNC\` 扩展前缀，统一分隔符、尾分隔符与大小写；真实 Windows 文件系统验证留给 T16。

## 稳定错误码

`invalid_workspace_id`、`workspace_not_registered`、`workspace_already_registered`、`invalid_selected_root`、`root_confirmation_required`、`invalid_relative_path`、`path_outside_workspace`、`symlink_not_allowed`、`path_not_found`、`permission_denied`、`not_directory`、`not_file`、`io_failure`、`registry_unavailable`。

错误只序列化稳定 `code`、`messageKey`、末级 `pathHint`、`contentSafe` 和 `retryable`，不向前端传递系统堆栈或无关绝对路径。

## 验证证据

- `cargo test --locked --manifest-path src-tauri/Cargo.toml`：15 个单元测试通过。
- `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`：通过。
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过。
- `pnpm build`：通过，TypeScript 镜像契约纳入严格类型检查。
- 覆盖：父级穿越、POSIX/Windows 绝对路径注入、非法工作区 ID、校验式反序列化、Windows 大小写/前缀、根链接确认、根内越界链接、链接循环、不可读/不存在目录、错误路径脱敏、未登记 ID、重复 canonical root、链接根与真实根去重。

## 未验证

- 未执行 Windows 实机文件系统测试；纯字符串 Windows 身份样例已通过，真实前缀、大小写和链接行为由 T16 CI 验证。
- 未执行浏览器或桌面交互验证；T2 没有页面、Tauri command 或点击链路。
- 未执行扫描、CRUD、安全写、回收站和窗口测试；这些能力尚未进入实现任务。
