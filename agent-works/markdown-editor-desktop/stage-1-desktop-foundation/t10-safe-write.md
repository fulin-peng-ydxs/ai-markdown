# T10 安全写入和文件修订底座

> 执行日期：2026-07-20
>
> 需求范围：R5 自动保存、恢复与外部冲突中的安全写入/修订子集；同时承接 R2 文件服务写入底座
>
> 任务状态：代码、macOS 临时工作区测试、静态检查和 release 构建已完成；真实 P1/Tauri IPC、Windows 替换与完整 R5 状态机仍由后续任务承接

## 1. 本次交付

- 新增 `WorkspaceSafeWriteService`、`safe_write_markdown_file` 及 Rust/TypeScript `SafeWriteResult` 契约。前端只提交工作区 ID、相对路径、逻辑文本和已知 `FileRevision`，不持有任意绝对路径写权限。
- 安全写只覆盖既有授权 `.md` 文件：Rust 在创建临时文件前和替换前分别流式计算磁盘修订，完整比较修改时间、大小、SHA-256、编码和换行类型；修订不一致返回 `file_revision_conflict`，不自动覆盖。
- 内容在目标同目录的隐藏临时文件中写入并 `sync_all`，继承目标权限后再由平台适配执行替换；成功后重新读取修订并返回，失败不更新界面事实。UTF-8 BOM 与 LF/CRLF/CR 主换行风格被保留，混合换行保持调用方原文，不擅自改排。
- 新增稳定错误：修订冲突、非 UTF-8、过大、安全写不可用和安全写失败；全部只返回文件名级 `pathHint`，保存失败保持 `contentSafe=true`。
- T4 状态仓储、T7 无覆盖移动与 T10 覆盖写统一复用 `fs/atomic.rs` 平台适配，不再维护三套私有重命名实现。安全写、T7 变更与 T8 删除继续共享一个进程内磁盘操作锁。
- 写成功后才向 T9 watcher 登记保存路径。自身记录改为匹配一个归并批次后消费，同批多事件仍归为应用来源，随后同路径外部事件恢复重扫，修复 T9 复核指出的 2 秒抑制盲区。

本任务没有实现输入防抖自动保存、手动保存按钮、页签保存状态、恢复快照、外部冲突对话框、覆盖二次确认或另存副本；不把 R5 标记为完整完成。没有新增数据库、SQL、seed、菜单、前端文件系统 capability、页面、样式或设计 token。

## 2. 写入与恢复边界

### 2.1 磁盘提交

- T6 的流式修订计算成为读写共享事实源；大文件检查不会为修订比较把全文再次保留在内存。
- 调用方必须提供读取时获得的 `FileRevision`。第一次比较阻止已知过期写入，临时文件完成后第二次比较覆盖写入准备期间的外部变化；平台替换前仍存在无法由普通文件系统 API 完全消除的极短竞争窗口，因此完整 R5 冲突状态机仍不得宣称完成。
- 已有文件为 POSIX 只读提示时在创建临时文件前拒绝；Windows readonly/ACL、目标占用和 `MoveFileExW` 行为必须由 T16 实际编译和测试。
- 平台替换是磁盘提交点。POSIX 替换后尝试同步父目录；若父目录同步失败，只记录文件名级诊断，因为此时替换已发生，报告“保存失败且原文未变”反而会制造虚假状态。Windows 适配使用 write-through 标志。

### 2.2 临时残件

- 临时文件名使用不可预测随机令牌；`appDataDir()/plainroot-safe-write-cleanup-v1.json` 在临时文件创建前登记路径，schema 为 v1，最多 32 项，不保存 Markdown 内容。若外部进程恰在登记后抢占同名路径，创建失败只撤销日志，不删除非本进程创建的文件。
- 写入或替换失败先即时删除；删除失败只输出临时文件名。下次启动从最近工作区取得历史授权根，只处理仍位于这些根内、文件名符合 Plainroot 临时格式且重新通过无符号链接路径校验的候选。
- 日志损坏、超限或不可写会使安全写服务返回 `safe_write_unavailable`，不会忽略日志继续写，也不会扩大删除范围。退出应用后删除日志不会改变 Markdown，只可能留下待后续人工或再次授权清理的隐藏临时文件。

## 3. 复用判断

- 已查找的同类实现：T6 `read_markdown_file`/`FileRevision`，T7 `WorkspaceMutationService` 与无覆盖重命名，T8 共享操作锁，T9 `WorkspaceWatchService`，T4 JSON 状态原子替换，以及现有 `contracts.ts`/`files.ts`。
- 已复用：T6 流式 SHA-256/编码/换行检测、T7/T8 磁盘串行锁、T9 watcher 自身来源、统一 `DesktopError`、Rust↔TypeScript 字段/错误码 parity 和现有前端桌面 API 模块。
- 本次新增的复用单元：`fs/atomic.rs` 同时服务状态仓储、无覆盖移动与安全覆盖写；`WorkspaceSafeWriteService` 是后续编辑器、手动保存、自动保存和冲突解决必须复用的唯一 Markdown 写入底座。
- 未抽取：清理日志没有复用 T4 `PlainrootStateV1`。两者生命周期和失败隔离不同：主状态损坏不应允许任意残件清理，清理日志失败也不应破坏最近记录；合并会扩大 schema 迁移和数据损坏影响面。
- 无页面、组件、视觉或点击链路变化，因此不修改 `DESIGN.md`、页面开发流程或原型。

## 4. 验证记录

| 验证 | 结果 |
| --- | --- |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | 通过：97/97；T10 安全写 11 项，watcher 8 项 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 通过 |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml` | 通过 |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | 通过 |
| `pnpm test:workspace-tree` | 通过：18/18 |
| `pnpm test:permanent-delete-feedback` | 通过：4/4 |
| `pnpm test:licenses` | 通过：2/2 |
| `pnpm licenses:check` | 通过：29 个 Node / 486 个 Rust / 0 个阻断项 |
| `pnpm build` | 通过：TypeScript 与 Vite 生产构建 |
| `pnpm tauri build --no-bundle` | 通过：生成 macOS arm64 release 可执行文件 |

安全写测试覆盖 BOM/CRLF、混合/CR 换行策略、五个中断点、原文件哈希保持、外部换靶、旧修订、非 UTF-8、缺失目标、只读、并发同修订、大小边界、即时清理、启动重试、日志超限、授权根外候选不删除和临时名抢占不误删；所有文件测试只使用系统临时目录。

## 5. 未验证与后续承接

- `safe_write_markdown_file` 的真实 Tauri IPC、P1 编辑消费者、保存状态反馈和 watcher 可见联动尚未执行，由 T13/T15 验证。
- Windows `MoveFileExW` 编译、目标占用、ACL/readonly、替换、目录持久化和清理日志公开路径语义本机无法验证，由 T16 `windows-latest` 收口；macOS 结果不得外推为双平台通过。
- 应用崩溃、系统休眠、网络卷和文件系统卸载的长时残件恢复未做真实产品冒烟；当前证据来自受控故障注入和服务重建测试。
- 自动保存、防抖、恢复快照、页签/关闭保护和完整外部冲突处理属于后续 R5/R13 计划。后续任何保存入口必须消费本命令，不得直接覆盖用户文件或绕过修订前置条件。
