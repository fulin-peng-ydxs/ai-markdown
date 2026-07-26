# T40 全页签安全结算开发留痕

## 1. 任务与范围

- 任务：T40 单页签/批量关闭与全页签结算。
- 需求承接：R2、R5、R6、R13，以及 R11/R30/R31 的页签结算子集。
- 页面功能点：P1 7.1.1、7.1.2、7.1.6。
- 本次只完成页签当前/其他/右侧/全部关闭，以及 rename/move/delete 命中打开页签时的安全结算和提交；没有进入 T41 的窗口替换、关闭/退出协调或打开偏好，也没有进入 T42 的已有会话启动恢复。

## 2. 原型门禁与页面复核

P1 上游原型没有完整覆盖多页签 dirty/saving/save_failed/readonly/conflict 混合集合。生产编码前新增：

- `agent-works/markdown-editor-desktop/prototypes/tab-settlement-dialog.html`

原型明确固定标题/进度和最终动作区，中部清单独立滚动；每项提供与状态匹配的保存、冲突处理、另存或放弃入口，放弃修改有第二次确认。只有全部目标具有安全去向时最终动作才启用，取消保持页签集合。

本地浏览器实际复核：

- 1100×760：无根级横向溢出，弹层清单独立滚动，最终动作初始禁用。
- 560×720：条目与动作区退化为单列，无根级横向溢出。
- 完成全部逐项决策后进度从未完成变为 4/4，最终动作才启用；放弃路径先进入明确的二次确认。

补充原型没有引入需求外的关闭结果或新的业务确认项。

## 3. 实际实现

### 3.1 不可变结算批次

新增 `src/features/tabs/tabSettlement.ts`：

- 批次目标固定 `tabId + incarnation`，旧页签 incarnation 不能命中新页签。
- 显式放弃/另存证据绑定当前 `generation + editVersion`；继续编辑后证据自动失效。
- 状态区分 safe、dirty、saving、save_failed、conflict、missing、readonly、unavailable、stale 和两种已解决结果，不把未解决内容误报为安全。
- 批次只有在每一项重新投影为安全后才能提交。

新增 `TabSettlementDialog`，复用 `AppDialog`、现有语义 token 与按钮体系。逐项保存继续消费 `DocumentSaveController`；冲突和另存分别复用既有 `ConflictDialog` 与 `SaveCopyDialog`，没有第二套保存、冲突、原生选择器或磁盘写通道。

### 3.2 一次性页签集合提交

`WorkspaceTabManager` 与 reducer 新增：

- 全目标 `settleTabs`；
- 校验全部 incarnation 后，以一个 collection revision 批量关闭；
- 校验目标 path identity 和 session generation/editVersion 后，以一个 collection revision 批量重映射 descriptor、路径索引和 runtime session。

结算期间可以有逐项真实保存，但页签移除不会部分发生。用户取消时全部页签保持打开；已经成功写入磁盘的保存不做虚假回滚。最终提交前发现目标陈旧或内容继续变化，会拒绝整个页签集合提交并返回可重试状态。

评审整改进一步把结算完成时的 `generation + editVersion` 固定到最终关闭目标。`closeTabsAtomically` 在异步释放恢复身份前后各复核一次；若删除命令执行期间又产生输入，页签保持打开并重新观察当前 session，不会用先前的安全结论静默丢弃新内容。磁盘删除已经完成时，界面明确提示用户另存仍需保留的内存内容，不伪装为删除回滚。

页签上下文菜单现已真实启用：

- 关闭当前；
- 关闭其他；
- 关闭右侧；
- 关闭全部。

### 3.3 文件树破坏性操作

T39 对命中打开页签的 rename/move/delete 使用临时安全阻断。T40 用统一结算替代该过渡行为：

1. 操作前由 `tabPathImpact` 收集全部受影响页签。
2. 对不可安全继续的项展示统一结算弹层。
3. 只有结算安全后才调用既有 Rust rename/move/trash/permanent-delete 命令。
4. 磁盘失败时保留原页签集合、原路径和树状态。
5. 磁盘成功后才批量提交新 path identity/runtime，或一次性移除全部受影响页签。

目录/文档移动后，内联图片链接基于新文档路径重新计算并进入各页签自己的保存链。该部分不伪装跨多个 Markdown 文件的磁盘事务：若目录移动已成功而某个链接写回失败，目录移动事实保持，相关页签保持打开和 dirty，并展示“目录已移动、链接尚未安全写回”的真实反馈。未打开文档和引用式图片仍沿用既有边界，不自动批量改写。

旧的活动单文档重开/重映射/关闭分支已删除，路径变更只保留全页签统一实现。

真实桌面回归首次暴露：活动页签完成路径重映射和图片链接改写后，React 尚未把新 Markdown 投影回已挂载 adapter，立即保存若再次采集旧 adapter 会覆盖刚完成的链接改写。现由 manager 生成的重映射保存显式跳过这一次陈旧 adapter 采集，直接结算刚提交的 runtime；正常用户编辑和普通关闭仍保持提交活动 adapter 投影的既有边界。

## 4. 复用判断

- 复用 `AppDialog` 的焦点圈定、Esc、关闭门禁和焦点返回。
- 复用 `DocumentSaveController` 的保存/恢复结算。
- 复用 `ConflictDialog`、`SaveCopyDialog` 和对应一次性令牌。
- 复用 `TabMenu`，只由 `TabContextMenu` 配置批量动作。
- 复用 `tabPathImpact`、`workspacePath`、`workspaceAssetPath` 和既有 Rust 文件命令。
- 新增 `tabSettlement` 是第二个以上关闭入口共同需要的纯状态能力；新增 `TabSettlementDialog` 是多个入口共用的安全关键 UI，不是页面私有副本。

## 5. 验证结果

2026-07-26 评审整改后本机实际通过：

- `pnpm test:tabs`：8 个文件，63/63。
- 全量 Vitest：31 个文件，249/249。
- Node 独立回归：许可证策略 4/4、永久删除反馈 4/4、工作区路径 3/3、文件树 18/18、fixture 1/1，共 30/30。
- Rust：200 项通过，1 项手动性能探针忽略。
- TypeScript 类型检查、Vite 生产构建通过。
- Rust fmt、全 target/all feature Clippy `-D warnings` 通过。
- 许可证：727 个 Node 包、511 个 Rust 包、0 个阻断项。
- macOS Tauri/WebKit 桌面 E2E：11/11；新增用例通过真实 IPC 和临时磁盘工作区覆盖关闭右侧、打开页签改名、移动及图片链接写回、删除/永久删除回退和磁盘成功后的页签提交。
- `git diff --check` 通过。

E2E 失败截图继续只作为本机/CI 诊断产物，`/artifacts/` 已纳入忽略规则，不进入版本库。

专项覆盖包括：

- dirty/saving/save_failed/readonly/conflict 与只读磁盘安全的状态分离；
- 放弃/另存证据在继续编辑后失效；
- 多 controller 中部分保存失败时不移除任何页签；
- 陈旧批次在任何页签移除前整体拒绝；
- 一次性批量关闭和 deterministic 活动项；
- rename/move 磁盘成功后才提交多个打开页签的新路径；
- 磁盘失败保留全部原页签路径；
- 删除成功后一次性关闭全部受影响页签；
- 异步放弃期间继续编辑会拒绝最终关闭并保持最新 dirty session；
- 真实移动链路不会由陈旧活动 adapter 覆盖重算后的图片链接。

## 6. 未验证与后续边界

- 本轮没有修改 Rust、Tauri capability、依赖、原生菜单、配置、环境变量、SQL 或 seed；仅启用既有 React 页签上下文菜单中的批量动作。
- T40 的 macOS Tauri/WebKit 真实磁盘链路已本地验证；Windows 与远端 CI 尚未覆盖第三阶段提交，macOS 结果不得外推为双平台通过。
- Windows 原生回收站、Explorer、系统辅助技术和真实系统输入仍未人工验证。
- 窗口替换、窗口关闭/应用退出消费该批次属于 T41。
- 仓储发现既有非空会话时的 `deferred_existing_session` 仍保持安全冻结，必须由 T42 启动恢复真实消费后才能恢复元数据写入；T40 未虚构提示或提前覆盖会话。

## 7. 相关文档

- 需求：`agent-works/markdown-editor-desktop/requirement.md`
- 阶段计划：`agent-works/markdown-editor-desktop/stage-3-tab-window-lifecycle/plan.md`
- 设计：`DESIGN.md`
- 架构：`agent-works/markdown-editor-desktop/architecture/markdown-document-editing.md`
- 桌面底座：`agent-works/markdown-editor-desktop/architecture/desktop-foundation.md`
