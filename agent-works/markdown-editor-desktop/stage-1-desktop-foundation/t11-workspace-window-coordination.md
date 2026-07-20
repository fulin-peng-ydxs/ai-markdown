# T11 工作区窗口协调与目录决策壳开发记录

## 功能的详细需求

- 任务：第一阶段 T11，承接 R1 的本地桌面多窗口底座和 R14 的一目录一窗口、同目录聚焦、当前窗口/新窗口/取消决策及根会话子集。
- 入口：T5 授权得到稳定 `workspaceId` 后调用窗口协调命令；原生“新建窗口/关闭窗口”菜单复用同一协调器；第二实例只把启动参数转交现有进程。
- 业务状态：`decision_required`、`opened_current`、`opened_new`、`focused_existing`、`cancelled`。本阶段不保存“记住选择”，也不实现页签保存检查、可见 P1/P2、逐根恢复或窗口位置尺寸恢复。
- 提交边界：同一 canonical root 已有窗口时只聚焦；当前窗口替换和新窗口打开必须先成功持久化最近记录与根会话，再提交内存映射和释放旧授权。失败不得留下第二个可写映射、孤立会话或虚假成功。
- 异常：窗口不存在、创建、聚焦、关闭、状态写入和协调锁失败均返回稳定错误；第二实例参数必须有界，不能在插件回调中把任意路径直接升级为授权根。

## 功能开发的实际结果

- 新增 `WorkspaceWindowCoordinator`，维护 workspaceId↔window label 双向映射、待恢复标签、保留标签和第二实例请求队列。
- 统一原生标签为 `plainroot-window-N`。历史 `main`、`launcher-N` 及其他旧会话标签在启动时无碰撞迁移；capability 只覆盖新标签族。
- 空窗口默认绑定第一个已授权工作区；已绑定窗口打开其他根时先返回决策；同根直接聚焦原窗口。取消会释放本次尚未使用的授权。
- 当前窗口替换先原子写最近记录和根会话，再更新映射并释放旧根；新窗口先创建、后提交状态，提交失败销毁未提交窗口并释放目标授权，保留原窗口。
- 最近工作区按 `lastOpenedAt` 排序并限制为 100 条，T5 的独立记录入口同步复用该上限。
- 注册官方 single-instance 插件并保持为第一个插件。现有进程只接收最多 16 个请求，每个请求最多 16 个参数、每个值最多 4096 字节；队列满时淘汰最旧请求。消费命令一次取走当前队列。
- Rust 命令和 TypeScript 封装已覆盖目录协调、新建窗口、关闭当前窗口和第二实例请求消费；工作区打开状态、窗口动作与请求结构纳入跨语言契约测试。

## 功能开发的具体实施方案

### 窗口与状态事务

- `src-tauri/src/window.rs` 是窗口协调事实源，复用 T2 `WorkspaceId`、T5 `WorkspaceAccessService` 和 T4 `PersistentAppState`，前端不比较 canonical path。
- 原生窗口 label 不直接使用 workspaceId。Tauri label 不可变，而 R14 允许当前原生窗口替换目录；因此使用稳定的 `plainroot-window-N`，再由根会话保存 workspaceId↔label 映射。
- `persist_workspace_binding` 在一个状态仓储更新中去重并写入最近记录和根会话。状态写失败时不提交协调器映射；新窗口失败路径额外销毁尚未提交的壳。
- 关闭已绑定窗口前先移除根会话；原生关闭失败时尽力恢复原会话，成功后再移除映射和授权。后续页签阶段接入保存门禁时，必须在调用该关闭路径前完成全部页签检查。

### 单实例与权限边界

- `tauri-plugin-single-instance` 只在 macOS/Windows 注册，并按官方约束作为第一个插件；Linux 不是产品目标，不启用该行为。
- 插件回调仅排队参数并聚焦一个已有窗口，不解析、扫描或授权路径。T12 读取队列后仍必须走 T5 的受控选择/确认语义，不能把命令行文本直接当可信绝对路径。
- `src-tauri/capabilities/default.json` 仍只有 `core:default`，窗口范围从历史标签改为 `plainroot-window-*`；没有增加 Dialog、FS、Shell、Store、HOME、网络或数据库权限。

### 页面流程与复用判断

- T11 没有创建页面、弹窗、样式或 token，因此不新增视觉组件，也不复制现有永久删除对话框。目录决策的可见交互归 T12/T13，届时必须执行页面开发流程并评估抽取共享 `AppDialog`。
- 原型只用于核对“当前窗口/新窗口/取消”和多窗口语义；固定路径、演示按钮、计时器和假成功反馈均未进入生产代码。
- `src/services/desktop/workspace.ts` 是统一 IPC 入口，后续页面不得复制 command 名称或自行拼装结果状态。

### 配置、执行时机、影响与回滚

- 依赖：`src-tauri/Cargo.toml` / `Cargo.lock` 新增精确版本 `tauri-plugin-single-instance = 2.4.3`；应用启动时在 macOS/Windows 注册。回滚依赖和注册代码后会恢复多进程行为，但不修改 Markdown。
- 窗口：`src-tauri/tauri.conf.json` 的启动标签改为 `plainroot-window-1`；`src-tauri/capabilities/default.json` 同步为 `plainroot-window-*`。回滚必须同步两处和状态标签迁移，避免窗口无 capability。
- 状态：沿用 `appDataDir()/plainroot-state-v1.json` 的 schemaVersion 1，只迁移既有字段值，不新增 schema 字段；失败沿用 T4 的原文件保护。回滚前可备份该辅助状态文件，Markdown 不受影响。
- 数据库、SQL、seed、环境变量、远端权限和初始化业务数据：均不涉及。

## 上线部署操作

1. 使用仓库锁定的 Node、pnpm 与 Rust 工具链执行 frozen install、Rust 全量检查、许可证门禁和 Tauri release 构建。
2. macOS/Windows 安装包必须验证只启动一个应用进程、第二次启动能聚焦已有窗口，并将参数交给现有进程；不得把本机 mock 结果外推为该项通过。
3. 升级已有状态时观察旧 `main`/`launcher-N` 标签迁移；迁移失败应保留 T4 可恢复状态并输出脱敏错误，不能修改用户 Markdown。
4. 回滚时同时回退插件、窗口标签配置、capability、Rust/TypeScript 契约；用户 Markdown 无迁移和回滚动作。

## 验证情况

- Rust 全量测试：107/107 通过；T11 窗口模块 13 项，覆盖统一标签、重复标签失败、空窗口绑定、同根聚焦、三选决策/取消、当前窗口替换、源窗口失效时释放未提交授权、新窗口隔离、状态失败回滚、旧标签迁移、待恢复标签保留、有界第二实例队列和 Rust↔TypeScript tagged contract。
- 前端回归：工作区树 18/18、永久删除反馈映射 4/4；TypeScript/Vite 生产构建通过。
- Rust 静态/构建：`cargo fmt --check`、`cargo check --locked`、`cargo clippy --locked --all-targets -- -D warnings` 和 `pnpm tauri build --no-bundle` 通过。
- 许可证：策略测试 2/2；29 个 Node 包、487 个 Rust 包、0 个阻断项。
- 验证过程披露：第一次命令因非交互 shell 未加载 Cargo PATH，在编译前以 `cargo: command not found` 退出；显式加载 `.nvmrc` 对应 Node 与 `~/.cargo/bin` 后，第二次在 `cargo fmt --check` 发现两处测试调用格式差异。应用标准 rustfmt 后重新执行上述整套命令，最终结果全部通过；两次中间失败均不作为通过证据。
- 未执行/未通过证据：没有 T11 可见页面，故不做浏览器视觉验收；真实 Tauri IPC、原生目录决策、逐根会话恢复、菜单失败的页面反馈、macOS 双进程 single-instance 和 Windows 构建/窗口行为尚未验证，分别由 T12～T16 承接。T11 不包含页签关闭保护，不能据此宣称完整 R14 通过。
