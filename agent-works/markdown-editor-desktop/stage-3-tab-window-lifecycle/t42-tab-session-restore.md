# T42 页签会话恢复与失败隔离开发留痕

## 1. 任务与范围

- 对应计划：`stage-3-tab-window-lifecycle/plan.md` T42。
- 对应需求：R1、R5、R10、R11、R13、R14，以及页面功能点 7.1.6、7.2.3。
- 本任务只完成既有非空页签会话的启动消费、活动项恢复、非活动页签惰性加载、逐项失败隔离和后续元数据写入接管；未进入 T43 原生页签命令。
- 页签会话仍只保存路径、顺序、活动项、模式、选择/锚点和最近关闭，不保存 Markdown、history、绝对路径或恢复正文。

## 2. 实际交付

### 2.1 恢复与惰性加载

- `restoreWorkspaceTabCollection` 把 Rust 已解析的路径契约恢复为有序轻量 descriptor，保留活动路径、视图和最近关闭，同时继续执行工作区、路径身份、展示字段和重复项不变量校验。
- `WorkspaceTabManager.restoreSession` 初始只加载首选活动页签；首选项读取失败时按顺序尝试下一可用页签，失败项保留真实状态，其他页签保持 `unloaded`。
- 点击或键盘激活 `unloaded` 页签会触发一次真实读盘；`begin_load` 在首个异步等待前提交，因此重复激活不会并发启动第二次读取。
- 恢复后的活动页签继续使用既有 `DocumentSession`、`DocumentSaveController` 和 recovery snapshot 匹配逻辑，没有第二份正文或恢复状态机。

### 2.2 持久化接管

- `WorkspaceTabSessionPersistence.initialize` 对既有 revision、页签、最近项或路径问题统一进入 `deferred_existing_session`，避免空启动集合覆盖可恢复元数据。
- P1 完成恢复后显式调用 `resumeAfterRestore`，以既有仓储 revision 接管后续防抖/CAS 保存。
- Rust 已隔离的问题项不会重新进入集合；恢复投影保持 dirty 并写回清理后的安全元数据。若写回失败，沿用 T41 的非阻断提示，已安全内容仍可关闭。

### 2.3 P1/P2 状态反馈

- P1 复用 `AsyncStatePanel` 显示逐项 missing、permission-denied 或通用错误，并提供“重新核对”和“跳过”。失败不会修改 Markdown，也不会阻断其他安全页签。
- P2 复用既有窗口恢复列表显示页签数量、会话 revision 和摘要错误；“恢复可用窗口”会跳过已知损坏项并继续其他窗口，失败项保留独立重试入口。
- 尚未读盘的恢复页签明确显示“等待载入文档”，不再误报为空文档。

## 3. 复用判断

- 已查找并复用：T36 Rust window-session repository/commands、`WorkspaceTabManager`、`WorkspaceTabSessionPersistence`、P2 恢复列表、`AsyncStatePanel`、第二阶段 recovery snapshot 链路。
- 新增内容仅为现有 manager/reducer/persistence 的恢复操作与 P1/P2 薄编排；没有新增第二套 Store、窗口协调器、恢复弹层、页签状态机或页面私有状态优先级。
- 本任务不存在同职责第二处实现，因此无需抽取新的共享组件。恢复问题列表是 P1 对既有 `AsyncStatePanel` 的页面组合，不单独登记为组件。

## 4. 数据、权限与配置

- 无数据库、SQL、seed 或初始化数据变化。
- 无 Tauri capability、菜单、环境变量、依赖或产品配置变化。
- 前端只消费 Rust 返回的工作区相对路径和 opaque identity；不自行构造绝对路径或声明路径授权成功。
- 恢复和失败重试只读用户文件；除既有自动保存/用户明确操作外，本任务不会写入 `.md`。

## 5. 验证证据

- `pnpm typecheck`：通过。
- T42 六个专项文件：105/105 通过。
- `pnpm test:tabs`：68/68 通过。
- `pnpm test:ui`：263/263 通过。
- Node 独立回归：许可证策略 4/4、永久删除反馈 4/4、工作区路径 3/3、文件树 18/18、fixture 1/1，共 30/30。
- `pnpm test:rust`：201 项通过，1 项手动性能探针忽略。
- `pnpm build`：通过；既有大 chunk 警告未变化。
- `pnpm licenses:check`：727 个 Node 包、511 个 Rust 包、0 个阻断项。
- `git diff --check`：通过。

新增测试覆盖：

- 有序 descriptor、活动项、视图和最近关闭恢复；
- 有问题的恢复投影保持待写，接管后以既有 revision 执行 CAS；
- 只加载活动页签、首次激活惰性加载、首选活动页签失败后回退；
- P2 页签摘要、单窗口失败不阻断其他窗口；
- P1 路径问题的跳过/重试；
- 恢复接管后元数据写失败仍允许已安全窗口关闭。

## 6. 未验证与后续

- 本任务未执行真实应用重启、多窗口逐项恢复、恢复后原生输入或 Windows 桌面 E2E；由 T45～T46 承接。
- 未新增 Tauri IPC，因此没有用浏览器 mock 冒充真实窗口恢复证据；P1/P2 的新状态以组件测试验证，真实桌面恢复仍明确未验证。
- 本任务未修改 Rust，未重跑 Rust fmt/全 feature Clippy；T41 已取得的 macOS 11/11 桌面结果只能作为既有回归，不能外推为 T42 重启恢复证据。
- 原生页签菜单、快捷键和聚焦窗口路由仍属 T43，未提前实现。
