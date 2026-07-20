# T8 回收站删除、永久删除回退与系统定位

> 执行日期：2026-07-20
>
> 需求范围：R2 文件与文件夹目录管理子集
>
> 任务状态：已完成代码、临时目录测试和生产构建；真实 P1 点击链路、macOS 系统废纸篓/Finder 与 Windows 平台证据仍分别由 T13/T15/T16 承接

## 1. 本次交付

- 新增 `trash_workspace_entry`：只接受已注册 `workspaceId` 与受控相对路径，重新校验授权根、符号链接和支持类型后进入系统废纸篓/回收站。
- 新增 `prepare_permanent_delete`、`confirm_permanent_delete`、`cancel_permanent_delete`：回收站失败后必须建立独立二次确认，不存在从失败分支自动调用永久删除的代码路径。
- 新增 `reveal_workspace_entry`：校验目标仍在授权根内后，通过官方 opener 实现在 Finder/Explorer 中定位。
- 新增 Rust/TypeScript 删除结果、永久删除提案和稳定错误码，并纳入跨语言 parity。
- 新增前端删除成功提交：磁盘成功前只保持 processing；成功后移除目标及其子树，过期 mutationId 不改变当前树。
- 新增具体 `PermanentDeleteDialog` 与第一批运行时语义 token。组件直接调用真实 prepare/cancel/confirm adapter，不使用原生 `confirm()`、固定结果或 toast。

本次没有进入 T9 外部监听、T10 安全保存、T11 窗口协调或 T13 完整 P1 文件树；没有删除最近工作区记录、修改数据库、菜单、Store schema、capability 或 SQL。

## 2. 文件安全与平台边界

### 2.1 回收站优先

- 正式依赖固定为 `trash` 5.2.6。macOS 使用 `NSFileManager` 模式，仍进入系统废纸篓，但不额外申请 Finder 自动化权限；Windows 使用 crate 的系统回收站实现。
- 回收站调用失败返回 `trash_unavailable`，`contentSafe=true` 表示应用没有执行永久删除；调用方只能展示回退选择，不能把同一次调用静默降级为不可逆删除。
- 系统定位固定使用 `tauri-plugin-opener` 2.5.4 的 Rust API。前端没有获得任意 path/opener capability，不能绕过 Rust 授权根直接打开绝对路径。

### 2.2 永久删除确认能力

- 提案使用操作系统随机数生成 `permanent-delete-v1-*` 一次性 ID，最长保留 5 分钟，内存最多保留 32 个。
- 提案绑定 workspace ID、规范化根身份、相对路径、条目类型和平台文件实体身份。确认期间路径被替换、类型变化、工作区变化、令牌过期、取消或重复使用均拒绝执行。
- 确认令牌在执行前消费。删除失败不会复用旧令牌；用户需要回到当前树状态重新发起，避免对变化后的目标重复执行。
- 文件使用 `remove_file`；目录使用 `remove_dir_all`。递归目录删除可能在平台报错前已删除部分子项，因此 `permanent_delete_failed` 明确返回 `contentSafe=false`，前端不得声称磁盘保持原状。
- T7 新建/重命名/移动与 T8 删除共用同一 `Arc<Mutex<()>>` 磁盘变更闸门，防止同一进程内并发修改绕过目标实体复核。

## 3. 前端页面设计闭环

### 页面定位

- 页面/窗口：P1 工作台文件树的永久删除回退对话框。
- 需求编号与功能点：R2；回收站不可用时二次确认永久删除。
- 当前阶段覆盖：具体 dialog、真实 desktop adapter、proposal 状态和删除成功后树提交。
- 用户主任务与入口：用户主动删除文件/目录，系统回收站返回不可用后，选择是否继续永久删除。
- 本次明确不做：完整 P1 文件树、右键菜单、真实页面挂载与系统点击 E2E；由 T13/T15 接入。
- 对应原型及保留区域：工作台原型没有文件永久删除弹窗，按 `DESIGN.md` 的 dialog 类型补充；不复制原型固定路径、计时器或说明控件。

### 数据与安全边界

- 内容/状态事实源：Rust command 返回的 `PermanentDeleteProposal`、`DeleteResult` 与 `DesktopError`。
- 授权根与路径校验：前端只发送 workspace ID、相对路径或确认 ID；Rust 临近 I/O 重新校验。
- UI 提交时点：只有 `trash_workspace_entry` 或 `confirm_permanent_delete` 返回成功后才移除树节点。
- 失败回滚与 contentSafe：回收站失败保持树；永久目录删除失败可能部分完成，显示持久错误并要求刷新，不用 toast。
- 跨窗口或跨页签影响：T8 不建立页签联动；T9/T13/T15 必须在真实消费时刷新其他可见状态，后续编辑阶段再处理当前文件恢复副本。

### 状态设计

| 状态 | 触发条件 | 页面反馈 | 可执行操作 | 恢复/退出条件 |
| --- | --- | --- | --- | --- |
| preparing | 弹窗打开，Rust 重新确认目标 | “正在重新确认文件状态…”；危险按钮禁用 | 取消 | 提案成功进入 ready；失败进入 error |
| ready | 一次性提案有效 | 展示对象名与不可恢复后果 | 取消、永久删除 | 确认进入 deleting；取消消费令牌 |
| deleting | 永久删除命令执行中 | 按钮显示“正在永久删除…”且禁止重复提交 | 无；Esc 不关闭 | 成功关闭并提交树；失败进入 error |
| error | 准备失败、换靶或删除失败 | `aria-live` 错误；说明安全状态与下一步 | 准备失败可重新确认；确认/删除失败只关闭并刷新 | 用户关闭后回到文件树重新发起 |
| empty | 不适用 | dialog 只在明确目标上打开 | 无 | 无目标时不渲染入口 |

### 布局与交互

- 页面原型：dialog。
- 主区与辅助区：对象/后果说明为主，状态错误块为辅助，固定操作区在底部。
- 滚动归属：短对话框自身不产生多层滚动；长文件名由后续 P1 消费时补 tooltip/截断验证。
- 宽窗口布局：最大宽 420px；使用 `paper`、`line-strong`、`danger` 与 4/6/9px 圆角语义。
- 1050px / 820px：宽度使用视口安全边距，不改变操作顺序；真实窗口截图由 T15 验证。
- 主、次、危险操作：默认焦点在“取消”；“永久删除”是唯一危险实底操作，不使用“确定”。
- 弹窗边界：Esc 等同取消；执行中 Esc 不关闭；关闭后恢复触发点。
- 键盘与无障碍：原生 dialog 负责焦点圈定；标题/说明关联，状态使用 `aria-live`，不依赖颜色表达；减少动态效果时禁用非必要 transition。

### 复用与维护

- 复用：现有 desktop contracts/files adapter、工作区树 mutation state、`DESIGN.md` alpha token。
- 新增复用单元：`src/styles/tokens.css` 是正式运行时 token 起点；后续 P1/P2 必须消费而非另建相同 hex。
- 不复用原因：仓库此前没有正式 dialog 或运行时 token；本次是首个具体危险确认组件，不预建无消费的通用 `AppDialog` 抽象。
- DESIGN：只把已确认 alpha token 写成 CSS 变量，没有新增视觉数值规则；同步 `DESIGN.md` 的工程事实。
- Store/schema/权限：无 Store/schema/数据库变化；opener 仅由 Rust 受控命令调用，不新增前端 capability。

### 验证

- Rust 单元/临时目录：78/78 通过，其中 T8 12 项覆盖回收站成功/失败、无隐式永久删除、令牌一次性/取消/过期/容量、目标换靶、递归目录、路径越界/内部链接、故障注入与非安全标记、定位适配、删除枚举 parity 和跨 T7/T8 串行。
- 前端状态：11/11 通过，其中 T8 2 项覆盖删除成功后子树移除和过期结果拒绝。
- 类型/构建：`pnpm build` 通过；具体 dialog 已被 TypeScript 编译，但因 P1 尚未建立，没有进入当前空壳运行时 bundle。
- 真实平台：macOS `trash`/opener 生产分支已编译；未启动 Finder、未向用户系统废纸篓写入测试项目。T15 从真实 P1 入口执行 macOS 冒烟；Windows 编译/回收站/Explorer 由 T16 验证。

## 4. 验证记录

| 验证 | 结果 |
| --- | --- |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | 通过：78 个 Rust 测试 |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | 通过 |
| `pnpm test:workspace-tree` | 通过：11 个前端状态测试 |
| `pnpm build` | 通过：TypeScript 与 Vite 生产构建 |
| `pnpm test:licenses` | 通过：2/2 许可证策略测试 |
| `pnpm licenses:check` | 通过：29 个 Node / 479 个 Rust / 0 个阻断项 |
| `pnpm tauri build --no-bundle` | 通过：生成 macOS arm64 release 可执行文件 |

## 5. 未验证与后续承接

- 真实 Tauri IPC、P1 文件树入口、回收站失败后打开对话框、键盘焦点与删除成功后的完整工作台联动：T13/T15。
- macOS 系统废纸篓与 Finder 定位：T15 人工冒烟。本次不为证明测试而向用户废纸篓写入残留项目，也不无界面启动 Finder。
- Windows `trash` 与 opener 分支编译、回收站/Explorer 行为：T16 CI 与最终人工清单。
- 删除当前打开文件后的恢复副本、页签与编辑内容保护：不属于第一阶段文件树底座，必须由后续编辑/页签阶段按 R2/R5/R13 承接。
- 永久目录删除失败的树重扫：T9 监听和 T13 文件树消费必须根据 `contentSafe=false` 触发刷新，不能继续展示旧树为已确认事实。
