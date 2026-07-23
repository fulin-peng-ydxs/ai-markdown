# T21 冲突证据与安全另存开发留痕

## 1. 任务与范围

- 任务：T21——冲突证据、一次性覆盖令牌和安全另存副本。
- 需求承接：R2、R5、R11，以及 P1 7.1.2 的保存/另存、冲突与恢复子流程。
- 本次完成：冲突磁盘证据、覆盖二次确认后端、原生保存对话框单目标提案、安全另存提交、格式策略、watcher 自身写入登记、Rust↔TypeScript 契约和故障测试。
- 本次不做：自动保存调度、恢复/冲突/另存可见弹层、编辑器接线、菜单启用、关闭窗口门禁、图片资源目录。它们仍由 T22～T31 承接。

## 2. 复用与技术边界

- 复用 `WorkspaceAccessService` 获取当前授权根，前端不能用绝对路径扩大文件权限。
- 冲突覆盖复用 `WorkspaceSafeWriteService` 的双重 revision 校验、同目录临时文件、原子替换和清理日志，不建立第二套原文件保存实现。
- 另存与既有文件变更、删除、安全写共享 `WorkspaceMutationService` 的 operation lock，避免应用内并发提交交叉。
- 原生目标选择复用现有 Rust 侧 `tauri-plugin-dialog` 模式；正式 capability 仍只有 `core:default`，没有给前端新增 Dialog 或通用文件系统权限。
- 编码和换行写出复用 safe-write 的统一 `encode_markdown_content`，避免原文件保存与另存形成两套格式规则。
- 保存成功后复用 `WorkspaceWatchService::record_write`；只有可映射到当前工作区相对路径的副本才登记，工作区外目标不形成新根授权。

## 3. 实际实现

### 3.1 冲突覆盖

`EditorSaveService` 在 prepare 时重新读取磁盘 `FileRevision`，并生成最多 32 项、5 分钟有效的随机一次性令牌。令牌绑定：

- `workspaceId`；
- 规范化工作区根身份；
- 工作区相对路径；
- 最新磁盘 revision；
- Rust 根据当前编辑内容计算的 SHA-256。

confirm 先消费令牌，再校验 workspace/root/content hash，随后把令牌内的最新 revision 交给既有 safe-write。磁盘再次变化、内容在确认后变化、令牌过期或重放都不会覆盖文件。只读或不支持编码的文件仍返回冲突证据供后续界面展示，但 `targetWritable=false`，确认覆盖由 safe-write 明确拒绝。

“重新加载磁盘版本”继续复用既有读取命令，“保持当前内容”不产生磁盘操作；T27 负责把它们和本次覆盖/另存契约组合成可见四选流程。

### 3.2 原生单目标另存

prepare 命令由 Rust 打开系统保存对话框。用户取消时返回 `cancelled`，不创建令牌、不写磁盘。选择目标后，后端绑定：

- 规范化父目录身份；
- 唯一目标路径和文件名；
- 目标是新文件还是已有文件；
- 已有目标的 revision；
- 本次输出 encoding/lineEnding；
- 若目标位于源工作区内，对应 workspaceId/relativePath。

前端 confirm 只提交一次性令牌、当前内容和 `overwriteExisting`，不能提交目标绝对路径。确认时再次校验父目录、文件类型、符号链接和目标 revision。新目标使用平台 no-replace；已有目标必须明确确认覆盖，随后使用同目录 `0600` 随机临时文件写入、`sync_all`、权限继承和平台原子替换。写入或提交失败由 guard 删除本次临时文件并保留原目标。

格式规则：

- 可编辑工作区源默认保留 UTF-8/UTF-8 BOM 与单一 LF、CRLF 或 CR；
- mixed 换行或不支持编码不能使用 `preserve`，必须明确选择 UTF-8 + LF/CRLF/CR；
- 全新无磁盘基线内容默认 UTF-8 + LF；
- 工作区源 revision 在创建目标令牌前必须仍与读取基线一致。

另存令牌不绑定正文 hash：它授权的是用户选择的单一目标，确认时保存当前最新编辑内容；这与“冲突覆盖必须绑定已确认内容”是两个不同语义。目标授权仍为单次、限时且不可换靶。

### 3.3 稳定契约

新增六个 IPC 命令：

- `prepare_conflict_overwrite`
- `confirm_conflict_overwrite`
- `cancel_conflict_overwrite`
- `prepare_save_copy`
- `confirm_save_copy`
- `cancel_save_copy`

新增稳定 DTO/tag/enum 与错误码，前端通过 `editorSave.ts` 和 `EditorSaveGateway` 消费。Rust 测试校验顶层字段、`SaveCopySource` tag、选择结果 status、格式枚举和目标状态枚举，防止手写 TypeScript 契约静默漂移。

## 4. 内容安全与异常闭环

- prepare/confirm 间源文件变化：拒绝创建或提交旧授权。
- 冲突确认后编辑内容变化：拒绝旧内容令牌。
- prepare/confirm 间目标变化、父目录失效或插入符号链接：拒绝且不改外部文件。
- 已有目标未明确覆盖：消费本次令牌并拒绝，必须重新取得目标证据。
- 并发确认、重放、过期或取消：至多一个提交成功。
- 写入中断：原目标不变，本次临时文件清理。
- 目标在工作区之外：只授权本次单文件，不注册为工作区、不持久化父目录权限。
- 错误只暴露稳定 code、内容安全性、可重试性和脱敏文件名，不向前端返回系统堆栈。

## 5. 验证证据

本机 macOS arm64 使用 Node 24.11.1、pnpm 11.5.1、Rust 1.97.1 实际通过：

- `cargo test --locked --manifest-path src-tauri/Cargo.toml --all-features editor::save_copy::tests -- --test-threads=1`：16/16。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --all-features`：152/152。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib --no-default-features`：152/152。
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`。
- `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`。
- `pnpm typecheck`。
- `pnpm test`：Vitest 71/71，且路径、树状态、fixture、许可证和永久删除 Node 测试全部通过。
- `pnpm build`。
- `pnpm test:licenses`。
- `pnpm licenses:check`：727 个 Node 包、508 个 Rust 包、0 个阻断项。
- `pnpm tauri build --no-bundle`：release 二进制构建通过。

专项测试覆盖内容 hash/revision 绑定、磁盘二次变化、只读、令牌重放/过期/容量、并发单消费、源 revision 变化、工作区外目标、UTF-8 BOM、LF/CRLF/CR、mixed/非法编码格式确认、已有目标显式覆盖、目标 TOCTOU、父目录失效、Unix symlink 换靶、故障注入、取消零副作用与 Rust↔TypeScript 契约。

## 6. 未验证与后续承接

- 未执行桌面 E2E：T21 没有 P1 页面消费者，现有 E2E 无法触发新增原生保存对话框；T27/T29 接入可见流程后由 T31 扩展。
- 未做原生保存对话框真实点击：当前只取得 release 编译与服务层测试证据，不能宣称 macOS/Windows 选择器交互通过。
- Windows 分支未在本机编译或运行：目标占用、`MoveFileExW` 替换、扩展路径公开序列化和原生对话框由 T31 的 Windows runner/人工验证承接；macOS 结果不得外推。
- 未验证自动保存、关闭门禁、恢复/冲突文案和焦点：对应消费者尚未实现。

## 7. 关联文档同步

- `stage-2-markdown-editing/plan.md`：T21 改为已完成，更新 R2/R5/R11 映射、测试状态和 T22 下一任务。
- `requirement.md`：只回写第二阶段实际进度和技术现状，不修改 R 编号、范围或验收含义。
- `architecture/desktop-foundation.md`：登记编辑保存授权服务、令牌和单目标路径边界。
- `AGENTS.md`、`README.md`：同步最新稳定能力、验证计数与未验证边界。
- 无需更新 `DESIGN.md`、页面原型和页面开发流程：本任务没有页面、组件、样式、token 或可见交互。
- 无需更新 SQL、seed、数据库、菜单、capability、产品环境变量或持久配置：本任务没有产生这些稳定事实变化。
