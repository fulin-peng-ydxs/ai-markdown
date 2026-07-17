# T2 领域契约与路径安全记录

## 范围与状态

- 任务：第一阶段 T2，承接 R2 的领域与路径安全底座。
- 状态：已完成。
- 本任务不提供扫描、文件 CRUD、安全写、窗口命令、Tauri command 或页面；这些仍由 T3、T5～T17 承接。

## 已落地契约

- Rust 模型：`WorkspaceDescriptor`、`WorkspaceRootResolution`、`FsEntry`、`FileRevision`、`RecentWorkspace`、`WorkspaceSessionRoot` 与 `DesktopError`。
- 前端镜像：`src/services/desktop/contracts.ts`，字段使用 camelCase，枚举值使用 snake_case；Rust 单测逐模型比较序列化字段集合，全量比较错误码与 `DESKTOP_ERROR_CODES`，并将 T5 的选择类型、tagged union 状态及 `already_open` 字段与 TypeScript 常量/固定 JSON 形状对照，任一侧单独变更都会失败。T2 建立了 14 个基础错误码，T3 新增 4 个窗口错误码，T4 新增 6 个状态仓储错误码，T5 新增 6 个选择/最近记录错误码，均受同一 parity 测试约束。
- 安全入口：`WorkspaceId` 和 `WorkspaceRelativePath` 在构造及反序列化时统一校验；拒绝父级、绝对路径、Windows drive/UNC 注入及 NTFS ADS 冒号；工作区描述符只能由已检查的根解析结果建立。
- 注册边界：`WorkspaceRegistry` 只接受已构造描述符；后续前端文件命令必须提交已登记 `workspaceId + relativePath`，由 Rust 重新解析实际路径。
- 链接规则：所选根本身是符号链接时保留 selected path、展示 canonical root 并要求确认；根内链接默认不跟随，链接越界与循环均拒绝；链接根和真实根按 canonical identity 去重。
- Windows 身份键：移除 `\\?\` / `\\?\UNC\` 扩展前缀，统一分隔符、尾分隔符与大小写；内部 canonical `PathBuf` 保留系统原值，对外序列化和最近记录去除扩展前缀，避免 UI 暴露设备路径写法；真实 Windows 文件系统验证留给 T16。
- 跨平台文件名：相对路径有意拒绝任何含冒号的分段，即使该名称在部分 POSIX 文件系统合法，避免同一契约在 Windows 被解释成 NTFS ADS。
- 非 UTF-8 路径：当前进程内 canonical `PathBuf` 保留原始系统路径，对外 JSON 使用 lossy Unicode 表示；此类罕见路径的最近记录不能保证字节级往返，T5 恢复时必须重新校验并在不一致时要求重新授权，不得据历史字符串直接访问。

## 稳定错误码

`invalid_workspace_id`、`workspace_not_registered`、`workspace_already_registered`、`invalid_selected_root`、`root_confirmation_required`、`invalid_relative_path`、`path_outside_workspace`、`symlink_not_allowed`、`path_not_found`、`permission_denied`、`not_directory`、`not_file`、`io_failure`、`registry_unavailable`。

错误只序列化稳定 `code`、`messageKey`、末级 `pathHint`、`contentSafe` 和 `retryable`，不向前端传递系统堆栈或无关绝对路径。

## 验证证据

- `cargo test --locked --manifest-path src-tauri/Cargo.toml`：17 个单元测试通过。
- `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`：通过。
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过。
- `pnpm build`：通过，TypeScript 镜像契约纳入严格类型检查。
- 覆盖：父级穿越、POSIX/Windows 绝对路径注入、NTFS ADS、非法工作区 ID、校验式反序列化、Windows 大小写/身份前缀/对外路径前缀、根链接确认、根内越界链接、链接循环、不可读/不存在目录、错误路径脱敏、未登记 ID、重复 canonical root、链接根与真实根去重，以及全部 Rust/TypeScript 模型字段和错误码 parity。

## 未验证

- 未执行 Windows 实机文件系统测试；纯字符串 Windows 身份样例已通过，真实前缀、大小写和链接行为由 T16 CI 验证。
- 未执行浏览器或桌面交互验证；T2 没有页面、Tauri command 或点击链路。
- 未执行扫描、CRUD、安全写、回收站和窗口测试；这些能力尚未进入实现任务。
