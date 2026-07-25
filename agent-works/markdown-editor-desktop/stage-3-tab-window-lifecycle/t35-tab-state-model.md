# T35 页签状态模型开发留痕

## 1. 任务与范围

- 任务：T35——页签状态机、契约与性能门禁。
- 需求映射：R3、R10、R13；同时为后续 R11/R31 页签状态反馈提供公共状态契约。
- 实施范围：纯 TypeScript 模型、测试、性能探针和相关文档。
- 明确未做：T36 持久化仓储、T37 runtime manager、P1 页签 UI、原生菜单、IPC、磁盘写入、全页签结算和桌面 E2E。

## 2. 实际交付

### 2.1 轻量页签契约

`src/features/tabs/tabTypes.ts` 新增：

- 窗口内稳定 `WorkspaceTabId`；
- 工作区相对路径、派生文件名与父路径提示；
- `idle/loading/ready/error/missing/permission_denied` 加载状态及 generation；
- 模式、选择、锚点组成的视图恢复元数据；
- 最近关闭描述、恢复描述和 10 种结算原因；
- `WorkspaceTabRuntime`，只引用既有 `DocumentSession` 与 `DocumentSaveController`。

页签描述和恢复 DTO 不包含 Markdown、history、恢复正文或保存控制器。运行时资源位于独立 `Map`，editor adapter 不进入集合；页面未来只能通过活动项 selector 获得一个 editor 投影。

### 2.2 纯状态机与不变量

`src/features/tabs/tabReducer.ts` 新增：

- 有序 tab ID、活动项、`Map` 路径索引、最近关闭和 revision/persistedRevision；
- 同一路径唯一打开与聚焦已有项；
- 激活、加载、陈旧 generation 拒绝、排序、关闭相邻项接替、最近关闭和重新打开；
- 最近关闭按路径去重并最多保留 50 项；
- 可执行集合不变量校验与待持久化判断；
- 只序列化相对路径和视图元数据的恢复描述；
- 活动 runtime 单一 selector。

未设置产品级打开页签上限；50 项边界只作用于最近关闭历史。

### 2.3 状态契约复用

复用审查发现 `AsyncStatePanel` 已实现 DESIGN 公共优先级。为避免页签模型产生第二套状态顺序，原有纯逻辑被提取到 `src/components/asyncState.ts`，现有面板继续消费同一实现，页签投影复用：

`permission_denied > missing > conflict > error > unsupported > saving > loading > dirty > readonly > empty > ready`

权限、位置、冲突和错误使用 `alert/assertive`；其余状态使用 `status/polite`。此次没有新增页面私有组件、样式或状态映射。

## 3. 验证证据

### 3.1 自动化

- `pnpm typecheck`：通过。
- `pnpm test:tabs`：12/12 通过。
- `pnpm test`：Node 独立回归全部通过；Vitest 24 个文件 188/188；Rust 180 项通过，另 1 项手动性能探针忽略。
- `pnpm build`：通过；既有源码 chunk 大小提示保留，T35 未增加生产入口或 bundle 依赖。
- `pnpm licenses:check`：727 个 Node 包、508 个 Rust 包、0 个阻断项。

### 3.2 性能与序列化门禁

本机 Node 24.11.1、Vitest 4.1.10 下执行 `pnpm test:tabs:performance`：

| 探针 | 均值 | 说明 |
| --- | ---: | --- |
| 打开并索引 100 个轻量页签 | 约 0.475 ms | 每次探针从空集合建立 100 项 |
| 在 100 个页签间执行 100 次活动切换 | 约 0.871 ms | 不重建非目标 session |

单元门禁同时建立 20 个已加载的小型 `DocumentSession` 引用，只投影一个活动 runtime；100 项恢复描述小于 64 KiB，且序列化结果不含 `markdown`、`history` 或 `saveController`。

上述证据只覆盖轻量模型和小型 session 引用，不代表多个真实大文档的峰值内存、自动保存 I/O 或 editor 挂载性能；这些仍由 T37/T45 验证。

## 4. 配置、权限与数据影响

- 数据库/SQL/seed：无变化。
- Tauri capability、文件权限和 IPC：无变化。
- 菜单、快捷键和环境变量：无变化。
- 产品配置、用户偏好和初始化数据：无变化。
- Markdown、恢复仓储和应用数据目录：无读写变化。
- 运行时依赖与锁文件：无变化。

因此本任务不需要数据迁移、配置回滚或页面截图。代码回滚只移除纯模型及测试，不影响用户文件。

## 5. 文档同步

- `stage-3-tab-window-lifecycle/plan.md`：T35 标记已完成，R3/R10/R13 更新为进行中，并记录实际证据和未验证边界。
- `DESIGN.md`：登记 `AsyncStatePanel` 与纯 `asyncState` 契约的共同事实源。
- `README.md`：新增页签模型与性能测试命令。
- `architecture/markdown-document-editing.md`：登记 T35 页签集合边界，同时明确 P1 尚未消费。
- `AGENTS.md`：同步当前阶段、代码边界、本地测试数和远端证据边界。
- `requirement.md`：未更新；T35 未改变需求范围、R 编号、建议项状态、验收标准或遗留确认项。
- `CLAUDE.md`：未更新；其仍是指向 AGENTS、需求、计划和架构的薄入口，没有新的长期规则需要复制。

## 6. 后续边界

T36 才能建立版本化窗口页签会话仓储和 Rust/TypeScript 契约；T35 的恢复描述目前只证明序列化边界，不代表磁盘恢复已经可用。T37 才能让 P1 持有多个真实 session/controller，T38 以后才出现可见页签。
