# T27 冲突、恢复、只读和另存交互

## 功能的详细需求

T27 对应 R5、R11、R30、R31，并承接 P1 7.1.2 与 P2 7.2.2/7.2.3 的单文档恢复、冲突、只读和另存副本子集。目标是把 T20/T21 已建立的恢复仓储、冲突证据和原生单目标另存令牌转成真实、可取消、可重试、键盘可达的页面流程。

恢复快照只允许载入当前工作区的唯一 `DocumentSession` 并形成未保存编辑态，不能直接覆盖 `.md`。冲突必须显示目标路径、磁盘证据、当前保存状态和内容位于内存、恢复快照或磁盘的安全位置；覆盖磁盘必须在重新取得一次性令牌后执行第二次确认。另存副本只消费 Rust 原生选择器签发的单目标令牌，已有目标需要明确覆盖动词，不能由前端提交任意绝对路径。

当前文档被外部删除时，P1 必须保留内存 Markdown，提供另存副本和安全关闭入口。关闭前必须确认当前 `generation/editVersion` 已有恢复快照或另存结果承接，不能用关闭动作静默丢弃仅存在于内存的内容。单个恢复条目损坏、过期、删除失败或工作区失效不得阻断其他条目和工作区继续使用。

## 功能开发的实际结果

- 新增 `src/features/editor/recovery/`，实现 `ConflictDialog`、`RecoveryDialog`、`SaveCopyDialog`、共享 `ContentSafetySummary` 和统一样式。三类弹层都组合既有 `AppDialog`、`AsyncStatePanel`、`plainroot-button` 与语义 token，没有复制焦点圈定、遮罩或私有颜色体系。
- 冲突弹层展示相对路径、磁盘修改时间与大小、当前 session 状态和内容安全位置；“准备覆盖磁盘版本”会重新取得绑定最新磁盘 revision 与编辑内容 hash 的一次性证据，第二步才允许“覆盖磁盘版本”。令牌过期、内容变化或磁盘再次变化都会保留当前内容并返回可重试状态。
- 另存副本先打开原生保存对话框取得 proposal，再显式提交新目标或“覆盖并保存副本”。只读、冲突、保存失败和外部删除均可进入同一流程。冲突或原文件丢失时使用 detached source 与明确 UTF-8 输出格式，不把失效源 revision 当作可保留的编码/换行基线。
- `documentSession.ts` 新增受控的冲突覆盖完成、外部删除和恢复载入转换。恢复载入会验证 workspace/path 身份，并基于重新读取的磁盘 revision、兼容性与只读状态建立唯一 session；有可写基线时形成 dirty，原文件缺失时形成 `save_failed/path_not_found`，不会直接写磁盘或创建第二份正文。
- P1 按当前 workspace 查询恢复快照，仅在快照内容与当前磁盘 revision 不同且身份匹配时提示。完整正文只在用户选择恢复时读取；恢复、删除、损坏和授权失效按条目隔离。
- P2 增加“检查 N 份未保存恢复内容”入口。它只验证并打开对应工作区，再由 P1 消费快照；P2 不读取后直接写回正文，也不扩大工作区授权。
- watch 收到当前文档的外部删除事件时，P1 将 session 转为 `save_failed/path_not_found`，保留当前 Markdown，并持续显示“另存副本”和“安全关闭文档”。安全关闭会先通过既有结算控制器争取恢复快照；只有快照或同一 `generation/editVersion` 的另存证据覆盖当前内容时才关闭。
- 成功冲突覆盖、明确放弃并重载磁盘以及恢复删除，都按活动快照保护顺序释放和清理。页面状态只由真实 session、恢复仓储与 IPC 结果驱动，不使用 toast 代替长期错误或磁盘提交。

当前未完成且不得外推：

- T28 的资源目录弹层、图片粘贴/拖放/选择和 Markdown 相对链接插入未实现。
- T29～T31 之前，没有真实 Tauri 原生保存对话框、桌面 E2E、完整 1280/1050/820/740 px 矩阵、macOS WebKit 或 Windows WebView2 产品证据。
- 系统输入法候选窗、系统辅助技术、强制进程终止、磁盘满、休眠、网络卷和文件系统卸载仍未验证。
- 当前仍是每窗口单文档；阶段 3 的多页签恢复和全部页签关闭检查不属于 T27。

## 功能开发的具体实施方案

1. `RecoveryDialog` 只渲染 metadata 列表。用户选择恢复后才调用 `getRecoverySnapshot` 获取正文，并再次校验 snapshot/workspace/path；P2 的恢复动作只打开工作区，P1 才创建编辑 session。
2. P1 读取当前磁盘文件并运行生产 Remark/GFM 兼容性解析，再调用 `restoreDocumentRecovery` 把恢复正文装入当前唯一 session。恢复不调用 safe-write；后续自动/手动保存继续由 `DocumentSaveController` 负责。
3. 冲突覆盖先调用 prepare 取得新证据，第二次确认才调用 confirm。成功结果通过 `completeDocumentConflictOverwrite` 更新 disk revision、source format、hash 与保存状态；失败保留 conflict session 和恢复证据。
4. 放弃当前内容并重新加载时，先取消覆盖令牌、释放活动恢复保护，再删除对应快照并重新读取磁盘，避免保护中的快照删除失败或旧内容重新出现。
5. `SaveCopyDialog` 不持有绝对路径输入框。原生选择器返回目标状态后，用户明确选择保存新目标或覆盖既有目标；成功结果只形成当前 editVersion 的已承接证据，不把工作区外目标注册成新的根授权。
6. 外部删除事件只改变 session 的保存/安全状态，不清空正文。安全关闭复用 T26 的结算控制器写入恢复快照；如果恢复失败且没有匹配版本的另存证据，页面拒绝关闭并保留可操作入口。
7. 三类弹层的 processing 状态禁用关闭；Esc、遮罩与取消使用 `AppDialog` 的既有契约，关闭后焦点返回触发点。恢复条目内部错误使用 `AsyncStatePanel`，不阻断其他条目。
8. 浏览器临时验证发现业务弹层的私有最小宽度大于共享 `AppDialog`，窄于声明宽度时产生横向裁切；最终样式改为消费对话框可用宽度，并删除临时验证入口，不把测试页面带入生产。

## 复用判断

- 已复用 `AppDialog`、`AsyncStatePanel`、`focusContainment`、`plainroot-button`、`DocumentSaveController`、`EditorRecoveryGateway`、`EditorSaveGateway` 和既有语义 token。
- `ContentSafetySummary` 同时被冲突和另存流程消费，属于同一状态定义的第二个消费者，已抽取为稳定复用单元。
- `ConflictDialog`、`RecoveryDialog`、`SaveCopyDialog` 的令牌生命周期、破坏性语义和失败恢复方式不同，保持三个业务组件，未抽成分支密集的通用弹层。
- P1 与 P2 的 gateway mock 命令集和恢复动作不同，当前不抽取测试工厂；出现第三个同契约消费者时再复核。

## 上线部署操作

本次无额外上线部署操作：

- 无数据库、SQL、seed、迁移或初始化数据。
- 无新增 Tauri capability、菜单、产品权限、环境变量、密钥、账号、远端服务或第三方配置。
- 无新增依赖、lockfile、持久配置格式、应用数据路径或脚本。恢复继续使用 `appDataDir()/plainroot-recovery-v1/`，另存继续使用 T21 的进程内一次性令牌。
- 无产品菜单启用变化；菜单和快捷键的活动 session 状态桥仍由 T29 统一处理。
- 回滚 T27 时需同时回退 P1/P2 消费者、三类弹层和 session 转换，不能只移除可见按钮而保留不可达状态。
- 已成功覆盖或另存的用户 Markdown 是明确磁盘提交，不随代码回滚自动改写；未使用的恢复快照继续按 recovery v1 生命周期保留。

## 验证情况

已执行并通过：

- 锁定 `node_modules` 下直接运行 TypeScript 编译器、Vitest 与 Vite：150/150 个 Vitest 通过，生产构建通过。
- 新增 14 项前端测试：6 项恢复/冲突/另存组件测试、3 项 session 转换测试、4 项 P1 接线与安全关闭测试和 1 项 P2 恢复入口测试。
- 组件测试覆盖冲突覆盖第二次确认、令牌过期、已有目标覆盖、冲突 detached source、恢复单项失败隔离、恢复只进入 dirty session、processing 期间 Esc 关闭门禁。
- P1/P2 测试覆盖恢复不直接写原文件、启动页只打开工作区、外部删除保留正文，以及恢复写入成功后允许关闭、恢复写入失败时拒绝关闭的双分支；session 测试覆盖冲突覆盖、恢复身份/状态与外部删除。
- Node 独立门禁：许可证策略 4/4、永久删除反馈 4/4、工作区路径 3/3、树状态 18/18、fixture 1/1。
- Rust 全量 171 项通过，1 项手动性能探针按设计忽略；`cargo fmt --check` 与 all-targets/all-features Clippy `-D warnings` 通过。
- 许可证清单：727 个 Node 包、508 个 Rust 包、0 个阻断项。
- 临时浏览器验证入口在 1280 px 下实际检查冲突四选项、覆盖第二次确认、恢复元数据、焦点和横向裁切；发现并修复业务弹层宽度问题后已删除临时文件。

未取得通过证据：

- 标准 `pnpm typecheck` 在执行脚本前触发本机供应链预检，并因不可达私有 registry `130.120.2.205` 重试；本轮停止等待后，改用锁定 `node_modules/.bin/tsc` 和对应本地二进制执行同一类型、测试与构建门禁。该问题不是 TypeScript 或测试断言失败。
- 本任务未运行真实 Tauri IPC、原生保存选择器、桌面 E2E、完整窗口尺寸矩阵、macOS WebKit 人工链路、Windows CI 或系统辅助技术。
- 未执行强制进程终止、磁盘满、系统休眠、网络卷和文件系统卸载长时测试。

## 关联文档同步

- 已更新第二阶段 `plan.md` 的 T27 状态、R5/R11/R30/R31 映射、页面功能点、实际落地、测试计划与风险边界。
- 已更新 `requirement.md` 的当前阶段和第 12 章实施状态。需求范围、R 编号、建议实现处理状态、验收标准和遗留确认项未因 T27 改变，不需要修改。
- 已更新 `architecture/desktop-foundation.md` 的 P1/P2、恢复/冲突/另存组件、外部删除保护和安全关闭不变量；已有架构文档能够承接本次稳定事实，不需要新建第二份技术架构文档。
- 已更新 `DESIGN.md` 的运行时组件登记和 Known Gaps；本任务未新增 token、断点、布局体系或私有颜色。
- 已更新 `README.md`、`AGENTS.md` 的当前稳定能力、测试数量与未验证边界。
- `CLAUDE.md` 继续作为指向 `AGENTS.md`、需求和阶段计划的薄入口，没有新增稳定规则，不需要更新。
- `page-development-workflow.md` 的通用页面流程未变化，不需要更新。
- SQL、seed、数据库、权限、菜单、配置、环境变量、脚本、依赖和 lockfile 没有稳定事实变化，不需要更新。
