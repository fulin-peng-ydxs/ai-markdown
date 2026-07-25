# T36 窗口页签会话仓储开发留痕

## 1. 任务与范围

- 任务：T36——版本化窗口页签会话仓储与 Rust/TypeScript 契约。
- 需求映射：R13、R14；为后续 R10 视图恢复、R11 状态反馈和 7.2.3 窗口会话恢复提供底座。
- 实施范围：应用数据目录内的页签元数据仓储、根会话引用、非敏感启动摘要、受授权命令、Rust 平台路径身份、跨语言契约和自动化测试。
- 明确未做：T37 每页签 `DocumentSession`/`DocumentSaveController` manager、P1 页签栏、P2 页签数量展示、全页签结算、打开偏好、窗口尺寸/布局、桌面 E2E。

T36 没有新增可见页面或可操作多页签入口。当前 P1 仍是单文档，不能把本任务表述为 R13/R14 已完成。

## 2. 实际交付

### 2.1 数据布局与内容边界

新增：

```text
appDataDir()/plainroot-window-sessions-v1/
├── manifest-v1.json
└── sessions/
    └── window-session-v1-<128-bit-random>.json
```

- manifest 保存 `workspaceId`、opaque `windowStateRef`、revision、页签数和更新时间；
- session 保存工作区相对路径、模式、选择/锚点、打开顺序、活动路径和最近关闭；
- session 不保存 Markdown、history patch、恢复正文、绝对根目录、窗口像素位置或三栏布局；
- manifest 上限 1 MiB/1000 工作区，单 session 上限 1 MiB，最近关闭最多 50 项；
- 超限返回 `window_session_capacity_exceeded`，不静默截断正在运行的页签。

`plainroot-state-v1.json` 继续只保存最近工作区和根窗口会话。工作区成功绑定前先由仓储创建真实 opaque ref，再写入 `WorkspaceSessionRoot.windowStateRef`；启动时为既有根会话补齐仓储引用。关闭窗口或只移除根恢复记录仍保留最后页签会话；移除最近工作区记录同步删除页签会话元数据，但不删除 `.md`、图片或恢复快照。

### 2.2 原子提交、CAS 与恢复

session 和 manifest 都使用：

1. 同目录私有随机临时文件；
2. `create_new` 与 Unix `0600`；
3. `write_all + sync_all`；
4. 既有平台原子替换适配层；
5. 父目录尽力同步。

保存先校验 manifest revision，再写 session，最后原子提交 manifest。若第二步后的 manifest 提交失败，仓储会恢复旧 session 字节；首次保存则移除未提交新文件。因此错误返回不会留下“新 session + 旧 manifest”的半提交状态。

其他安全行为：

- stale `expectedRevision` 返回 `window_session_revision_conflict`；
- 同一 revision 的并发保存经仓储互斥与 CAS 保证只有一次提交成功；
- manifest 损坏先备份，再从文件名、schema、workspace/ref、路径和视图均验证通过的 v1 session 重建；
- 单 session 损坏只备份并隔离该项，不阻断其他工作区；
- 未知 manifest/session schema 原文件不覆盖；
- 启动孤儿清理只删除 Plainroot 命名、普通文件且明确声明 schema v1 的记录，不跟随符号链接，也不猜测删除未来版本文件；
- revision 0 的新引用读取为合法空会话，不制造“记录不存在”错误。

### 2.3 授权、摘要和路径身份

新增命令：

- `resolve_workspace_tab_path`；
- `get_workspace_tab_session`；
- `save_workspace_tab_session`；
- `remove_workspace_tab_session`。

完整路径读取、保存、删除和单路径解析都要求：

1. 当前 WebView 窗口确实绑定目标 `workspaceId`；
2. 工作区仍在 Rust 授权注册表；
3. 相对路径由 `WorkspaceRelativePath` 解析；
4. 读取时再次在 canonical root 内解析并拒绝符号链接越界。

Rust 对当前平台解析后的文件身份计算：

```text
workspace-path-v1-sha256(workspaceId + nativeCanonicalIdentity)
```

前端只比较 opaque identity，不自行 lower-case，也看不到绝对 canonical root。恢复中缺失或无权限的单项进入 `issues`，其他有效页签继续返回。

P2 launcher snapshot 新增 `windowSessionSummaries`，只包含 workspace、opaque ref、revision、页签数、更新时间和可选的已知错误；摘要直接读取 manifest 与进程内已知 issue，不逐份读取最多 1000 个 session 文件。完整 session 在授权读取时发现的损坏或未知版本会回写为已知 issue；未授权启动页不获得页签文件名或相对路径。

### 2.4 契约与错误

Rust/TypeScript 共同新增：

- editor mode、visual/source selection、semantic/source anchor；
- persisted tab、recently closed、snapshot；
- resolved path、resolved tab、单项 issue、完整 session、save result、summary；
- 8 个稳定 window-session 错误码和用户可理解的安全文案。

所有导出 interface 与字符串常量进入现有总 parity 守卫。前端新增 `src/services/desktop/windowSession.ts` 薄 gateway，不承担路径推导、权限判断或磁盘成功声明。

## 3. 自动化验证

### 3.1 专项测试

Rust 专项覆盖：

- 新 ref 读取为空 revision 0；
- session 保存、重载、解析和 opaque path identity；
- CAS 陈旧写、跨 workspace/ref 和未绑定窗口拒绝；
- 同一 revision 并发保存只提交一次；
- session replace 前故障保持旧 revision；
- manifest replace 前故障回滚 session；
- 未知版本保留且不能被后续保存覆盖；
- 单 session 损坏备份隔离；
- manifest 损坏从有效 v1 session 重建并保留未知版本文件；
- 最近关闭与 1 MiB 容量边界；
- 缺失路径单项隔离；
- orphan 只清理 Plainroot v1 普通文件；
- 删除元数据不触碰工作区 Markdown；
- path identity 稳定且不泄露绝对根；
- 根工作区提交后 `windowStateRef` 与 manifest 真实一致；
- Rust/TypeScript 字段和 enum/tag parity。

### 3.2 本地结果

- `pnpm test`：Node 独立回归 30/30；Vitest 24 个文件 200/200；Rust 197 项通过，另 1 项既有手动性能探针忽略。
- `pnpm typecheck`：通过。
- `pnpm build`：通过。
- `cargo fmt --check`：通过。
- `cargo clippy --locked --all-targets --all-features -- -D warnings`：通过。
- `pnpm licenses:check`：727 个 Node 包、508 个 Rust 包、0 个阻断项。

未执行桌面 E2E：T36 新命令和仓储尚无 P1/P2 可见交互消费者，现有 9 条桌面用例不会形成新的用户链路证据。远端 macOS/Windows 双平台绿灯仍只覆盖第二阶段提交；T36 的 Windows 编译、IPC 和 E2E 必须由后续 T45/T46 及远端 CI 补齐。

## 4. 配置、权限与回滚

- 数据库/SQL/seed：无变化。
- Tauri capability：无变化，仍为最小 `core:default`；命令由 Rust 侧校验窗口和工作区授权。
- 菜单/快捷键：无变化。
- 环境变量：无变化。
- 运行时依赖/锁文件：无变化。
- 产品偏好：无变化。

回滚代码不会修改用户 Markdown。若需要手工清除 T36 辅助状态，可在应用退出后备份并删除 `plainroot-window-sessions-v1/`；再次启动只会失去页签路径/视图恢复元数据，不影响 `.md`、图片、最近工作区根记录或恢复快照。未知版本文件应保留，不能用旧版本自动覆盖。

## 5. 文档同步与未验证边界

- `plan.md`：T36 标记已完成，R13/R14 和验证基线同步为实际结果。
- `requirement.md`：只更新阶段 3 开发状态与证据路径；需求范围、R 编号、建议项处理、验收标准和遗留确认项不变。
- `architecture/desktop-foundation.md`：登记窗口页签会话模块、事务、授权、路径身份和 app data 数据边界。
- `README.md`：同步第三阶段当前能力与 T36 证据入口。
- `AGENTS.md`：只沉淀当前稳定模块边界、测试入口和远端证据边界。
- `CLAUDE.md`：无需更新；仍是指向 AGENTS、需求、计划和架构的薄入口。
- `DESIGN.md`、页面流程和原型：无需更新；T36 没有页面、组件、样式或交互变更。

仍未验证：

- P1 多页签 runtime、单一重型 adapter 和 heap/RSS 门禁（T37）；
- P1/P2 可见页签与恢复链路（T38/T42）；
- 全页签结算、偏好和窗口替换保护（T40/T41）；
- 真 Tauri IPC、Windows 编译和双平台 E2E（T45/T46）；
- Windows 原生系统 UI、系统 IME、峰值内存和长时文件系统边界。
