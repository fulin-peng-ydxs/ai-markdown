# T26 自动/手动保存与窗口结算

## 功能的详细需求

T26 对应 R2、R5、R11、R14，并承接当前单文档的保存与窗口生命周期子集。目标是在 P1 的唯一 `DocumentSession` 上接入自动保存、手动保存和恢复快照，使保存状态只由真实磁盘提交结果驱动；切换当前文件、对当前文件执行路径变更、关闭窗口、当前窗口替换根目录和应用退出前，必须经过同一结算链路。

自动保存按 Markdown 的 UTF-8 字节数分级防抖，保存与恢复快照分别单飞。保存期间发生的新编辑不能覆盖在途 request，也不能在旧写入完成后被误标为 clean；结算必须追赶到最新 `editVersion`。保存失败、外部 revision 冲突或恢复仓储降级时，必须准确说明内容仍位于内存、恢复快照或磁盘何处。

窗口结算不能让 Rust coordinator mutex 横跨前端等待。重复关闭必须复用同一 intent；应用退出需要结算全部已绑定工作区窗口，任一窗口拒绝即取消整组。当前阶段仍为每窗口单文档，不实现页签集合关闭检查，也不实现 T27 的冲突、恢复、只读与另存可见弹层。

## 功能开发的实际结果

- 新增 `src/features/editor/save/DocumentSaveController.ts`，按 `≤5 MiB` 800 ms、`>5～20 MiB` 2 秒、`>20 MiB` 5 秒调度自动保存；恢复快照通常 2 秒，大于 5 MiB 时 10 秒。字节计量不分配完整 `TextEncoder` 缓冲。
- 保存与快照各自单飞并合并陈旧请求。保存期间继续编辑会在当前写入结束后追赶最新正文；`settle()` 会等待追赶写完成，不把首个成功结果误当最终 clean。
- P1 自动保存和工具栏“保存”按钮统一调用既有 `safeWriteMarkdownFile`。只有 Rust 返回新 `FileRevision` 后才清洁 session；`file_revision_conflict` 转为 T21 的真实冲突证据，其他失败保留 `save_failed` 与内容安全状态。
- dirty session 会登记为 T20 活动恢复项并写入最新快照。成功保存会先释放活动保护再删除匹配快照；保存期间晚到的旧快照会被删除，不能把已保存文档重新标记为可恢复。恢复写失败不会在无新编辑时形成计时器自旋。
- `documentSession.ts` 增加冲突和恢复快照的受控状态转换；这些转换仍以 generation/editVersion/requestId 拒绝陈旧结果，不新增第二份正文或保存事实源。
- `WorkspaceWorkbench.tsx` 以当前 ready session 创建唯一保存控制器，接入手动保存、自动观察、切换当前文件结算，以及当前文档重命名、移动、删除前结算。结算失败时文件树选中、当前文档和磁盘路径均保持原状态。
- Rust `WindowSettlementCoordinator` 为 `close_window`、`replace_workspace`、`quit_app` 生成稳定 intent；前端通过 `resolve_window_settlement` 返回 allow/reject。系统关闭、原生菜单关闭、当前窗口根替换和应用退出都进入该链路。
- 重复关闭复用一个 intent；当前窗口替换在 allow 前不改变绑定；多窗口退出为同组意图，任一 reject 取消其他待决 intent，全部 allow 后才退出。结算协调锁只保护意图登记和解析，不跨越 WebView 回应。
- 现有关闭窗口菜单已改为请求结算。T26 没有提前启用 `Cmd/Ctrl+S` 原生菜单：菜单启用状态仍需 T29 的活动窗口/session 状态桥，当前只提供真实工具栏手动保存，避免悬空命令或由后台窗口错误控制全局菜单。
- Rust↔TypeScript 契约新增 `settlement_required` 打开结果、窗口结算 intent/kind/resolution/status，并由 parity 测试锁定。

当前未完成且不得外推：

- T27 的冲突、恢复、只读和另存选择弹层未实现；冲突状态目前阻止结算并保留内容。
- 阶段 3 的多页签及全部页签关闭检查未实现；本任务只结算每窗口当前单文档。
- T29～T31 之前，没有真实 Tauri 系统关闭、应用退出、macOS WebKit 或 Windows WebView2 的产品链证据。
- 强制结束进程无法经过正常结算；安全边界依赖最近一次恢复快照和既有原子写，不宣称强制退出无数据窗口。

## 功能开发的具体实施方案

1. P1 读取成功后仍由 T19 建立唯一 `DocumentSession`。工作台以 workspace/path/generation 为身份创建保存控制器，并在每次 session 变化时传入最新引用；换文档或卸载时销毁旧控制器。
2. 控制器观察 dirty editVersion，分别安排保存与快照计时器。手动保存取消自动保存计时器并进入同一 `startSave`；若已有保存，则只记录 pending edit，当前请求完成后重新读取最新 session。
3. 写入使用 T10 的 safe-write IPC。返回 revision 后以请求开始时的 editVersion 完成保存：期间无新编辑则 clean；有新编辑则保持 dirty 并立即追赶。冲突结果先取得 T21 覆盖证据，再把 session 转为 conflict。
4. 恢复快照通过 T20 的 register/upsert/release/delete 完成。活动登记在首次 dirty 时建立；快照只声明覆盖其提交时的 editVersion，不能覆盖更新后的编辑。保存成功后释放保护并删除当前快照。
5. 页面切换文档或修改当前文档路径前调用 `settle("switch-document")`。只有 `clean/saved/readonly` 或最终保存成功才继续磁盘/页面事务；失败、冲突和内容不安全均保持原 UI。
6. Rust 在系统 close、菜单 close、当前窗口替换和 `RunEvent::ExitRequested` 上创建 intent 并发给目标窗口。前端完成 session 结算后按 intent id 回传 allow/reject；Rust 校验 intent 与窗口身份后再执行原有关闭/替换事务。
7. 应用退出使用 group id 关联所有工作区窗口；任一 reject 清除组内其他意图，全部 allow 设置一次性 exit bypass 后调用退出。launcher 窗口无工作区正文，可沿用直接关闭。
8. 最终实现与 T26 计划一致。保存频率采用计划候选值，但性能探针证明 64 MiB 全量安全写仍有约 5.6 秒 debug 路径延迟，因此这些值只作为当前保守运行常量，T30/T31 仍需 release/WebView 和双平台复测。

## 上线部署操作

本次无额外上线部署操作：

- 无数据库、SQL、seed、迁移或初始化数据。
- 无产品环境变量、密钥、账号、远端服务或第三方配置。
- 无新增 Tauri capability、插件、持久配置格式或应用数据路径。
- 恢复快照继续使用 `appDataDir()/plainroot-recovery-v1/`；安全写继续使用既有 cleanup 日志。T26 只新增运行时消费者，没有数据迁移。
- 原生菜单未新增项目；既有关闭窗口命令改为进入结算门禁。回滚 T26 时需同时回退前端结算监听、Rust intent/resolution 契约和关闭/退出接线，不能只回退一侧。
- 用户已经成功保存的 Markdown 不随代码回滚自动恢复或改写；未保存快照仍按 recovery v1 规则保留。

## 验证情况

已执行并通过：

- 锁定 Node 24.11.1 环境下前端全量：136/136 Vitest。
- Node 独立门禁：许可证策略 4/4、永久删除反馈 4/4、工作区路径 3/3、树状态 18/18、fixture 1/1。
- TypeScript 类型检查和 Vite 生产构建；主 bundle 405.05 kB，排版 chunk 334.02 kB，源码 chunk 543.59 kB，源码 chunk 仍保留既有大块告警。
- Tauri release 编译通过并产出 `src-tauri/target/release/plainroot`；命令行临时覆盖只跳过已单独通过的前端 prebuild，不改变仓库配置、feature 或 Rust release 依赖图。
- 许可证清单：727 个 Node 包、508 个 Rust 包、0 个阻断项。
- Rust 全量：171/171 通过，1 个手动性能探针按设计忽略；`cargo fmt --check` 与全 target/all feature Clippy `-D warnings` 通过。
- 保存控制器专项覆盖 UTF-8 尺寸分级、防抖、单飞、pending chase、快照节流、冲突、晚到快照、恢复失败不自旋、失败结算与追赶保存。
- 组件与窗口专项覆盖手动保存、切换/关闭结算、重复 close、根替换、应用多窗口退出、reject 回滚、持久化失败和 Rust↔TypeScript 契约。
- 手动 safe-write 性能探针在本机 debug 测试路径测得：5 MiB 约 430 ms、20 MiB 约 1650 ms、64 MiB 约 5558 ms。该结果用于保留大文件延迟风险，不作为性能通过声明。

未取得通过证据：

- 聚合 `pnpm test` 与标准 `pnpm tauri build --no-bundle` 会在脚本执行前触发当前不可达私有 registry 的供应链预检，长时间重试后被停止；不是测试断言或 Rust 编译失败。已用锁定 `node_modules` 逐项执行同一前端测试、许可证、类型与 Vite 构建；Tauri 构建使用命令行临时配置仅跳过该重复的 `beforeBuildCommand` 后，release Rust 编译通过。
- 本任务未运行桌面 E2E、真实系统关闭/退出、macOS WebKit 人工链路或 Windows CI；这些由 T29～T31 承接，不把第一阶段远端证据外推到 T26。
- 未执行强制进程终止、磁盘满、系统休眠、网络卷和文件系统卸载长时测试。

## 关联文档同步

- 已更新第二阶段 `plan.md` 的 T26 状态、R2/R5/R11/R14 映射、实际落地、验证计划、风险和非阻塞假设。
- 已更新 `requirement.md` 的阶段实施状态与第 12 章阶段证据；需求范围、R 编号、建议实现处理、验收标准和遗留确认项没有变化。
- 已更新 `architecture/desktop-foundation.md` 的保存控制器、恢复触发、窗口结算、菜单和运行不变量。
- 已更新 `DESIGN.md` 的 P1 组件职责与 Known Gaps；本任务无新 token、布局或样式体系。
- 已更新 `AGENTS.md`、`README.md` 的最新稳定能力和验证边界。
- `CLAUDE.md` 仍是指向 `AGENTS.md`、需求和阶段计划的薄入口，没有新增稳定规则，不需要更新。
- `page-development-workflow.md` 的页面流程未发生稳定规则变化，不需要更新。
