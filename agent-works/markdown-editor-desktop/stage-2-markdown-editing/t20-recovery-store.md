# T20 版本化恢复快照仓储

## 功能的详细需求

- 对应第二阶段计划 T20，承接 R5 的单文档短期恢复底座，不提前实现自动保存、恢复弹层、冲突处理或多页签恢复。
- 在系统应用数据目录建立独立的版本化恢复仓储；Markdown 工作区文件仍是持久事实源，恢复快照只能作为未保存内容的短期安全副本。
- 每个工作区/相对文档只保留最新一份快照，默认保留 7 天，最多 32 项，正文总量最多 128 MiB。清理顺序为过期项后非活动最旧项，当前进程活动脏会话的最后快照不得被自动淘汰或直接删除。
- 写入失败、容量不足或未知版本时，必须返回“仅内存安全”的可观察结果，不得谎报快照已持久化；恢复只读取应用自身仓储，不修改用户工作区 Markdown。
- 无工作区授权时只允许列出不含绝对路径和正文的元数据；读取正文必须同时匹配当前授权 workspace、snapshot id 和工作区相对路径。

## 功能开发的实际结果

- `src-tauri/src/editor/recovery.rs` 新增 `RecoveryRepository`：
  - 使用 `appDataDir()/plainroot-recovery-v1/manifest-v1.json` 与 `snapshots/*.md`，不改变 `plainroot-state-v1.json`。
  - 正文先写入新的 `0600` opaque 文件并同步，再原子提交 manifest；manifest 提交失败时删除未提交文件并继续保留上一份有效快照。
  - 实现 7 天、32 项、128 MiB 三重边界，活动 dirty session 注册/释放、过期/最旧清理、重复文档替换、显式删除保护和 `memory_only` 降级。
  - 启动时移除只属于 Plainroot 的普通孤儿/临时文件；损坏 manifest 会备份并逐项保留仍可验证的条目，缺失或损坏快照只影响对应项；未知 schema 原文件保持不变。
  - 快照正文保存 SHA-256，读取时复核文件类型、大小、hash 和 UTF-8；仓储契约不序列化应用数据绝对路径。
- `src-tauri/src/commands/editor.rs`、`commands/mod.rs` 与 `lib.rs` 注册 list/get/upsert/delete/cleanup/register/release 命令并在应用 setup 初始化仓储。大正文 I/O 使用 blocking runtime；读取正文前由 `WorkspaceAccessService` 验证当前授权。
- `src-tauri/src/error.rs` 新增恢复仓储稳定错误码；`src/services/desktop/contracts.ts` 增加恢复 DTO、状态枚举和 Rust↔TypeScript parity 事实源。
- `src/services/desktop/recovery.ts` 沿用现有 desktop service 分层封装原始 IPC；`src/features/editor/editorGateway.ts` 只组合 `EditorRecoveryGateway`，没有在 feature 层复制第二套 `invoke` 封装。
- 当前没有 P1/P2 页面消费者、自动快照计时器或恢复对话框。T26/T27/T29 才负责把仓储接入保存控制器和真实页面流程，因此 T20 完成不等于 R5 产品验收完成。

## 功能开发的具体实施方案

1. 以 `RecoverySnapshotMetadata` 绑定 `workspaceId + relativePath + baseRevision + contentHash`，manifest 只保存相对身份、时间、大小和 opaque 文件名，不保存正文或绝对工作区路径。
2. upsert 前要求调用方登记活动脏会话；候选 manifest 先按策略清理，但不立即删除旧文件。只有新 snapshot 和 manifest 都成功提交后，才删除被替换或淘汰的旧快照。
3. 清理始终保护 `active_dirty` 中每个文档的最后快照。若剩余活动快照已经占满容量，返回 `memory_only + recovery_capacity_exceeded`，让后续保存控制器维持内存安全与关闭门禁。
4. 成功保存、明确放弃或安全关闭由后续调用方先释放活动登记，再决定删除或允许清理；仓储自身禁止在仍活动时显式删除。
5. manifest 逐条反序列化和校验，非法条目被隔离；完整未知版本不迁移、不覆盖。snapshot 正文损坏通过 get 的稳定错误暴露，不阻断其他快照读取。
6. 使用已有 `fs::atomic` 平台替换/不覆盖适配，不复制 Windows/macOS 原子语义；IPC 薄封装沿用 `services/desktop`，错误码与 DTO 沿用现有 parity 测试框架。

## 复用判断

- 已查找的同类实现：`src-tauri/src/state.rs` 版本化状态仓储、`fs/safe_write.rs` 安全写/清理日志、`fs/atomic.rs` 平台原子适配、`commands/files.rs` blocking IPC、`services/desktop/files.ts` 桌面调用封装和 `contract_test.rs` parity helper。
- 已复用的能力：`fs::atomic`、`WorkspaceId`/`WorkspaceRelativePath`/`FileRevision`、`WorkspaceAccessService`、`DesktopError`、Tauri blocking runtime、desktop service 分层和 parity helper。
- 本次新增的复用单元：`RecoveryRepository` 与 `services/desktop/recovery.ts` 是后续 T26/T27/P1/P2 的唯一恢复仓储入口。
- 未抽取的重复点及理由：恢复 manifest 没有并入 `PersistentAppState`，因为前者含敏感正文引用、独立容量/期限/活动保护和损坏隔离，后者只保存最近工作区与根窗口会话；强行合并会改变 state v1 schema 并扩大故障影响。私有临时文件创建保留在 recovery store 内，因为它还绑定 opaque snapshot、正文提交顺序和故障注入，当前不形成新的跨模块公共 API。
- 需要同步维护：已更新桌面底座架构、计划、需求阶段状态、README 与 AGENTS；本任务无页面、组件或 token 变化，DESIGN 和页面组件清单不需要更新。

## 上线部署操作

- 本次无 SQL、数据库 schema、seed、业务环境变量、菜单、前端 filesystem capability、账号或远程服务变更。
- 应用 setup 会在系统应用数据目录自动创建 `plainroot-recovery-v1/`；Unix 目录为 `0700`，manifest/snapshot 为 `0600`。无需人工初始化脚本。
- 版本回退时旧版本不会消费该目录，也不得自动删除或覆盖未知 schema。用户退出应用后可备份并删除整个 recovery 目录以清除短期副本；该操作不会修改工作区 `.md`，但会失去未保存内容的恢复机会。

## 验证情况

- `cargo test --locked --manifest-path src-tauri/Cargo.toml editor::recovery::tests -- --test-threads=1`：18/18 通过。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --all-features`：133/133 通过。
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过。
- `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings`：通过。
- `pnpm typecheck`、`pnpm test`、`pnpm build`：通过；Vitest 71/71，生产 Web 产物正常生成。
- `pnpm test:licenses`、`pnpm licenses:check`：4/4，727 个 Node 包、508 个 Rust 包、0 个阻断项。
- 专项证据覆盖：原子故障保留旧快照、活动保护、容量降级、释放后淘汰、两个 64 MiB 级逻辑容量边界、过期清理、重复路径替换、损坏/未知版本、身份错配、孤儿/临时文件、Unix 权限失败、非 UTF-8 app-data 路径安全失败、`0600` 和 Rust↔TypeScript parity。
- 未执行桌面 E2E、Tauri 打包和浏览器页面验证：T20 没有页面消费者或原生交互变化，真实保存/恢复页面链路由 T26/T27/T29/T31 验证。
- 未取得 Windows 远端证据：本地 macOS 结果不能外推 Windows；T31 负责在当前阶段最新提交上执行 macOS/Windows CI。Windows `MoveFileExW` 本次由既有平台适配复用，未在本任务独立实机验证。
