# T22 工作区资源偏好与图片导入服务

## 功能的详细需求

- 对应需求：R2、R6、R11；任务来源为第二阶段计划 T22。
- 每个工作区有独立资源目录偏好，默认 `assets/`，支持读取、修改和恢复默认；配置必须是当前授权根内的相对目录，不能通过绝对路径、`..`、非法名称或符号链接扩大权限。
- 图片导入支持 PNG、JPEG、GIF 和 WebP，按实际二进制签名校验，单项上限 20 MiB；SVG 明确拒绝。
- 资源文件必须先安全写入工作区、生成不覆盖已有文件的唯一名称，再向编辑器返回可迁移的工作区相对路径。
- 图片落盘与 Markdown 插入之间必须可回滚：插入成功确认保留，插入失败或取消只清理本次新建且未被外部修改的副本。用户选择的原始图片不得删除。
- 本任务只交付后端、IPC 和前端网关契约，不提前实现 T23/T28 的编辑器 upload hook、粘贴、拖放、配置弹层或 Markdown 链接插入。

## 功能开发的实际结果

- `src-tauri/src/preferences.rs`
  - 新增 `plainroot-preferences-v1.json` 独立仓储，按 `workspaceId` 保存 `assetDirectory`。
  - 默认目录为 `assets/`；限制配置文件 1 MiB、最多 1000 个工作区。
  - 使用同目录私有临时文件、同步和平台原子替换；写失败保留磁盘和内存旧值。
  - 损坏配置先备份再回到默认；未知 schema 保留原文件且拒绝旧代码覆盖。
- `src-tauri/src/editor/assets.rs`
  - 新增 20 MiB 的 PNG/JPEG/GIF/WebP 签名校验和 MIME 一致性检查，拒绝 SVG。
  - 资源目录逐段检查现有节点，拒绝 symlink、文件节点、越界和跨平台非法/保留名称。
  - 资源写入使用共享 workspace mutation lock、`0600` 随机临时文件、`sync_all` 和平台 no-replace 提交；重名按 `name-2.ext` 递增，不覆盖已有资源。
  - 上传和导入令牌均最多 32 项、5 分钟有效、随机且单次消费；错误工作区不能消费其他工作区令牌。
  - 取消、过期和正常进程释放只在原生文件身份、长度和 SHA-256 都未变化时删除本次副本。
- `src-tauri/src/commands/editor.rs`、`src-tauri/src/lib.rs`
  - 注册资源偏好 get/set/reset、raw upload 准备/上传、原生图片选择、导入确认/取消共 8 个命令。
  - Web 输入通过 `Uint8Array` raw IPC 加 opaque upload id，不把最多 20 MiB 图片编码成 JSON 数字数组。
  - 原生选择由 Rust 系统选择器产生单个输入路径；写入成功后登记 watcher 自身变化。
- `src/services/desktop/contracts.ts`、`assets.ts`、`errors.ts`、`src/features/editor/editorGateway.ts`
  - 新增资源偏好、上传、导入提案、结果和 tagged outcome 契约，以及稳定错误码、安全文案和编辑器 gateway。
  - Rust↔TypeScript 字段名、图片类型和选择状态已纳入 parity 测试。
- 当前未完成：
  - P1 尚无资源配置弹层、图片粘贴/拖放/选择入口或 Markdown 链接插入消费者，分别由 T23/T28 承接。
  - WebView raw IPC 和真实系统图片选择器尚未运行时冒烟；Windows 分支尚无本阶段远端证据。
  - 若进程被强制终止在“资源已经写盘、Markdown 尚未插入”窗口，可能留下孤立资源。当前没有持久化清理证据，因此应用不会在下次启动猜测删除用户文件。

## 功能开发的具体实施方案

1. 应用 setup 初始化版本化偏好仓储和资源导入服务；资源服务与 CRUD、安全写、删除服务复用同一 workspace mutation lock。
2. 读取/修改/重置资源目录前，命令层先从 `WorkspaceAccessService` 获取当前授权 workspace，再由 Rust 校验相对目录和现有路径节点；偏好写入成功后才替换内存状态。
3. Web 图片输入先提交 workspace、声明 MIME 和建议名称，后端签发绑定 workspace/root identity/资源目录/图片类型的 upload token；随后前端以 raw IPC 上传二进制。
4. 原生文件输入只消费 Rust 系统选择器返回的路径，使用有界读取取得最多 20 MiB 内容；只读源文件，不移动或删除源。
5. 后端根据签名识别图片类型，在已重新验证的资源目录中写入私有临时文件并同步，通过 no-replace 选择唯一目标名。
6. 落盘成功后返回 `AssetImportProposal`，其中只包含 `workspaceId`、工作区相对 `assetPath`、格式和长度，并签发 import token。
7. 编辑器未来完成 Markdown 插入后调用 confirm；插入失败或用户取消时调用 cancel。后端在清理前重新验证文件身份、长度和内容 hash，目标已被外部替换时拒绝删除。
8. 实际实现与 T22 计划一致。计划中的“单次图片不高于 20 MiB”已固化为 20 MiB；新增 raw IPC 是为避免大二进制 JSON 放大，不扩大产品范围。

## 上线部署操作

- 新增本机配置文件：`appDataDir()/plainroot-preferences-v1.json`，应用首次启动时按需初始化，无需用户手工创建。
- 新增工作区数据：图片只在用户发起导入时写入当前 `assetDirectory`；默认目录为授权根内 `assets/`。
- 回滚：退出应用后可备份并删除偏好文件以恢复默认资源目录；不得自动删除已经导入的资源文件。
- 本次不涉及数据库、SQL、seed、业务环境变量、账号、远程服务、API key、菜单、Tauri capability 或发布签名配置。

## 验证情况

已实际执行并通过：

- `cargo test --locked --manifest-path src-tauri/Cargo.toml editor::assets::tests -- --test-threads=1`：10/10。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml preferences::tests -- --test-threads=1`：4/4。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --all-features`：167/167。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib --no-default-features`：167/167。
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过。
- `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`：通过。
- `pnpm typecheck`：通过。
- `pnpm test`：71/71 Vitest，并通过 4 个许可证策略、4 个永久删除反馈、3 个工作区路径、18 个文件树状态和 1 个 fixture 测试。
- `pnpm build`：通过，生产 JS 251.87 kB、gzip 77.63 kB。
- `pnpm test:licenses`、`pnpm licenses:check`：727 个 Node 包、508 个 Rust 包、0 个阻断项。
- `pnpm tauri build --no-bundle`：通过，生成 `src-tauri/target/release/plainroot`。

本次未执行：

- `pnpm test:e2e`：T22 没有 P1 页面消费者，现有 E2E 无法触发新增资源命令；真实页面链路由 T28/T31 扩展后验证。
- macOS 系统图片选择器、WebView raw IPC、粘贴/拖放人工冒烟：尚无 UI 消费者，当前无法从产品入口触发。
- Windows 编译、WebView2 raw IPC 和原生选择器：本任务尚未推送，不能把 macOS 结果外推为 Windows 通过；由 T31 远端矩阵和人工项承接。
