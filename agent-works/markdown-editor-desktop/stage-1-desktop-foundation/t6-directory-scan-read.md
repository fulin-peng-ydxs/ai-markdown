# T6 目录扫描与 Markdown 读取开发留痕

## 范围与需求映射

- 任务：T6。
- 需求：R1 本地授权工作区子集、R2 文件与文件夹目录管理的扫描/读取子集、P1.1 文件树数据底座。
- 已完成：授权根内目录的后台分批扫描、懒加载子目录、取消与刷新、Markdown 安全读取、文件修订/编码/换行识别、Rust/TypeScript 契约和前端渐进树状态。
- 未进入：T7～T10 的 CRUD、回收站、监听和安全写入；T12～T15 的页面、真实 IPC/E2E 与原生选择器链路；编辑会话、页签和保存状态机。

## 实现结果

- Rust `WorkspaceScanService` 使用后台线程与容量为 4 的同步通道，单批最多 128 个结果；活动会话最多 16 个，同工作区同目录重新扫描会撤销旧 scanId，避免旧批次覆盖刷新结果。
- 扫描只接受已经登记的 workspaceId 和 Rust 校验后的相对目录。根目录和子目录均在临近 I/O 时复查类型；隐藏项、非 `.md` 文件和符号链接不进入树，单项失败以脱敏 `DesktopError` 留在批次中，不阻断其他条目。
- 前端 `WorkspaceTreeState` 按目录保存 scanId、进度、局部错误和完成/取消状态；开始刷新时移除该目录旧子树，过期批次被忽略。
- Markdown 读取在 blocking worker 中流式处理，不阻塞 async command 执行器；结果包含 SHA-256、修改时间、大小、UTF-8/BOM 和换行类型。读取期间尺寸或修改时间发生变化时拒绝返回不一致快照。
- 当前内联正文上限为 64 MiB。超过上限返回 `too_large`，非 UTF-8 返回 `unsupported_encoding`；两种状态均保留修订元数据但不返回正文，后续 UI 不得将其置为可编辑状态。该上限是第一阶段防内存失控的实现边界，不改变需求对大文件降级提示和安全打开的验收义务。
- 新增 `scan_not_found`、`scan_unavailable`、`file_changed_during_read` 稳定错误码；Rust 序列化字段、错误码全集和 TypeScript interface 由现有 parity 测试约束。

## 验证证据

- `cargo test --locked --manifest-path src-tauri/Cargo.toml`：55/55 通过。
- `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`：通过。
- `cargo check --locked --manifest-path src-tauri/Cargo.toml`：通过。
- `pnpm build`（Node 24.11.1、pnpm 11.5.1）：通过。
- `pnpm test:licenses`：2/2 通过；`pnpm licenses:check`：29 个 Node 包、431 个 Rust 包、0 个阻断项。
- `pnpm tauri build --no-bundle`：通过，生成 macOS release 可执行文件。
- 覆盖：空目录、深目录懒加载、1000 个 Markdown 文件多批次、隐藏项和非 Markdown 过滤、取消/刷新、目录失败/权限拒绝、链接不跟随、UTF-8 BOM、跨 64 KiB 缓冲区字符、LF/CRLF/CR/Mixed、非 UTF-8、超大正文和契约字段。

## 未验证与后续承接

- Windows 隐藏文件属性分支未在本机编译/实测，交由 T16 Windows runner。
- start/poll/cancel/read 的真实 Tauri IPC 与 capability、P1 文件树渲染、轮询节奏、千文件可见交互和手动刷新入口尚无页面消费者，交由 T12/T15。
- macOS/Windows 的权限撤销时序、极端同名替换竞态和真实大文件 UX 仍需平台集成验证；当前单测只证明核心服务和安全状态契约。
- 本任务没有新增数据库、SQL、seed、菜单、页面、权限 capability 或初始化数据，不需要对应迁移与回滚。代码回滚只移除 T6 命令/服务/前端状态；不触碰用户 Markdown 和 T4 状态文件。
