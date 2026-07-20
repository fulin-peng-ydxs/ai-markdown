# T9 外部变化监听与文件树一致性

> 执行日期：2026-07-20
>
> 需求范围：R2 文件与文件夹目录管理中的外部变化监听子集
>
> 任务状态：已完成代码、macOS 原生 watcher 临时目录测试、树状态测试和生产编译；真实 P1 消费、Windows watcher 与产品 E2E 仍分别由 T13/T15/T16 承接

## 1. 本次交付

- 新增 `WorkspaceWatchService` 和 `start_workspace_watch`、`restart_workspace_watch`、`poll_workspace_watch`、`stop_workspace_watch`，每个已授权工作区至多保留一个递归监听会话。
- 新增 Rust/TypeScript 的 watch start、batch、event、status、source 与 change kind 契约，并将字段、枚举值和新增错误码纳入自动 parity。
- 新增有界事件合并：原始回调队列 1024、批次队列 8、单批待处理事件 512、活跃 watcher 16；120ms 静默窗口合并并设置 500ms 最大延迟，避免持续事件风暴无限等待。
- 新增自身操作登记：T7 新建/重命名/移动与 T8 回收站/永久删除只有在磁盘成功后登记短期操作路径；对应平台事件标记为 `application`，不会再次安排文件树重扫。应用与外部路径混合时标记 `mixed` 并保守重扫。
- 扩展现有 `WorkspaceTreeState`：外部事件只排队受影响目录，不立即清空已展示树；后续复用 T6 扫描批次执行 reconcile，成功后原子移除失效项并保留仍存在目录的已加载子树。
- 新增根目录健康检查、终止状态与重启路径：根删除、权限撤销或 watcher 失败停止继续监听；根不可访问时清空不可再信任的树，单纯 watcher 后端失败时保留最后可读树供手动刷新；旧 watchId 在同工作区重启后失效。

本任务没有进入 T10 安全写入、R5 当前编辑文档冲突/恢复副本、T11 窗口协调或 T13 P1 页面；没有新增数据库、SQL、seed、菜单、Store schema、前端文件系统 capability 或初始化数据。

## 2. 一致性与资源边界

### 2.1 跨平台事件语义

- 正式依赖锁定为 `notify` 8.2.0。macOS 使用 FSEvents，Windows 使用 ReadDirectoryChangesW，Linux 开发环境使用 inotify；业务契约不依赖某个平台固定产生 create/rename/remove 的特定序列。
- watcher 返回的路径先相对化并通过 `WorkspaceRelativePath` 校验；绝对路径、非 UTF-8 路径或超出根的路径不会进入前端。无法安全表达或原始队列溢出时只发 `rescan_required`，由根扫描重新建立事实。
- dot 隐藏项事件不直接进入业务事件；Windows 隐藏属性仍由 T6 扫描过滤，因此最坏只触发一次无结果重扫，不会把隐藏内容暴露到树。
- Access/read 噪声不进入变化流；create/modify/remove/rename/other 只作为来源提示，文件树最终一致性以受影响目录重扫结果为准。

### 2.2 自身操作去重

- 自身操作记录最多 128 项、保留 2 秒，记录 workspace ID、内部操作 ID 和旧/新相对路径；不保存绝对路径或写入应用状态文件。
- 记录发生在磁盘操作成功之后，避免失败操作污染监听来源。watcher 的 120ms 合并窗口允许命令完成后登记赶在事件发布前生效。
- 同一批包含多个应用操作时仍归类为 `application`，operationId 留空表示不是单一操作；只要存在未匹配外部路径即归类 `mixed` 并重扫，优先保证不漏外部变化。
- T10 复核整改后，自身操作记录在匹配一个归并批次后立即消费；同一次保存落入同批的 create/modify 等多种平台事件仍统一标记为 `application`，随后同路径事件恢复为 `external` 并触发重扫，避免原 2 秒保留窗口吞掉后续外部修改。
- 平台若只上报父目录或工作区根，事件无法安全绑定具体自身操作，会保守执行目录/根重扫；这可能多一次读取，但不会漏掉外部变化或产生虚假磁盘状态。

### 2.3 文件树归并

- `applyWorkspaceWatchBatch` 通过 watchId 与 sequence 拒绝旧会话/过期批次；外部和 mixed 批次仅追加去重的 `rescanDirectories`，不乐观修改文件节点。
- `beginWorkspaceWatchRescan` 消费现有 T6 `WorkspaceScanStart`，以 reconcile 模式保持上一棵可见树；扫描完成且无错误后，才移除未再次观察到的直接子项及其子树。
- 仍存在的目录沿用原 `children` 子树，因此后续 P1 的展开状态不会因父目录刷新被无条件清空。新增直接子项在完整批次成功后一起提交。
- 局部错误或取消不能证明旧子项已被删除：保留最后安全快照、记录 scan issue 并把目录重新加入刷新队列。根失效属于安全阻塞状态，清空不可再读取的树并等待重新授权/重启。

## 3. 复用判断

- 已查找的同类实现：`WorkspaceScanService`、`WorkspaceMutationService`、`WorkspaceDeleteService`、`WorkspaceTreeState`、desktop contracts/files adapter 和 `workspace-tree-state.test.mjs`。
- 已复用：T6 的 scan start/batch 与相对路径模型、T7/T8 的磁盘成功提交结果、现有树 entries/children/scans/mutation 状态和同一 Node 测试入口。
- 本次新增复用单元：`WorkspaceWatchService` 是多窗口后续可共享的受控后台能力；watch 契约和 reconcile reducer 供 T13 P1、后续 R5 冲突与 R12 索引消费。
- 未抽取的重复点：start/restart 两个 Tauri command 当前都调用同一 `WorkspaceWatchService::start`，保留两个稳定意图入口以便 UI 区分首次启动和错误恢复；再抽一层只会隐藏命令语义，没有重复业务状态。
- 无视觉、布局、样式、token 或新页面变化，因此不修改 `DESIGN.md` 或页面开发流程。

## 4. 验证记录

| 验证 | 结果 |
| --- | --- |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | 通过：85 个 Rust 测试，其中 T9 7 项 |
| `cargo test ... fs::watch::tests -- --test-threads=1` | 连续两轮通过：每轮 7/7，覆盖真实 macOS watcher、事件风暴、根删除、重启、自身操作和契约 |
| `pnpm test:workspace-tree` | 通过：18 个前端状态测试，其中 T9 7 项 |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml` | 通过 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 通过 |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | 通过 |
| `pnpm build` | 通过：TypeScript 与 Vite 生产构建 |
| `pnpm test:permanent-delete-feedback` | 通过：4/4 |
| `pnpm test:licenses` | 通过：2/2 |
| `pnpm licenses:check` | 通过：29 个 Node / 486 个 Rust / 0 个阻断项 |
| `pnpm tauri build --no-bundle` | 通过：生成 macOS arm64 release 可执行文件 |

## 5. 未验证与后续承接

- 四个 watch 命令的真实 Tauri IPC、P1 打开工作区后启动/轮询/停止、手动刷新入口和可见 missing/permission-denied/retry 状态尚无页面消费者，由 T13/T15 验证。
- macOS 本次真实触发的是临时目录 FSEvents；没有监听用户文档目录。系统休眠、网络盘、超大目录和文件系统卸载的长时间运行行为未验证，T15 产品冒烟补充。
- Windows `ReadDirectoryChangesW` 分支在本机未编译/实测，由 T16 `windows-latest` 验证编译、事件风暴、重命名序列、根删除和 watcher 重启；Windows 原生 UI 仍保持未验证。
- 当前编辑文件被外部修改/删除后的冲突、恢复副本和另存/关闭选择属于 R5/R13 后续阶段；T9 只保留相对路径变化事件，不提前创建页签或内容竞争状态。
- T10 已在磁盘替换和修订读取成功后把保存路径登记到同一自身操作来源；自动保存尚未实现，后续接入必须继续复用该命令，不得另建绕过 watcher 去重的写入路径。
