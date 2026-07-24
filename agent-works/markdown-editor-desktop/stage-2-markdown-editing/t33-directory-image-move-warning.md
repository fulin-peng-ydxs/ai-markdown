# T33 目录图片移动风险提示

## 功能与需求

T33 对应 R2、R6、R11、R31，并承接 P1 7.1.1、7.1.2 的目录移动和图片资源联动。用户已确认：

- 移动当前工作区配置的资源目录，或递归包含 PNG/JPEG/GIF/WebP 的目录前，提示“未打开 Markdown 文档中的相对图片链接可能失效”。
- 提供“继续移动（链接可能失效）”和取消；取消不得执行磁盘移动。
- 提示只表达目录级风险，不声称已经找到具体 Markdown 引用，不自动批量改写其他文档。
- 当前打开文档的内联图片链接继续沿用 T28 的移动后调整；引用式图片仍不在自动改写范围。

## 实际实现

### Rust 风险边界

- `WorkspaceMutationService::inspect_move_risk` 在已有 workspace 授权和规范化相对路径边界内检查目标。
- `WorkspaceMoveRisk` 返回目标类型、配置资源目录是否受影响、是否发现受支持图片、检查是否受限，以及最终是否可能造成链接失效。
- 递归检查最多访问 10,000 个目录项，不跟随符号链接。超过上限、目录项读取失败或资源偏好不可用时以 `inspectionLimited=true` 保守提示，但不虚构图片或引用命中。
- `inspect_workspace_move_risk` 仍由 Rust 命令层重新取得当前窗口对应的 workspace 授权，前端不能提交任意绝对根目录。

### P1 交互

- 继续复用现有移动 `AppDialog`、operation state、gateway 和按钮样式，没有新增第二套对话框、焦点逻辑、颜色 token 或路由。
- 用户首次提交目录移动时先进入风险检查；检查期间禁用重复提交和关闭。
- 命中风险时留在同一对话框展示可预见后果。只有再次选择“继续移动（链接可能失效）”才调用既有磁盘移动命令。
- 取消、检查失败或磁盘移动失败均不提交文件树状态；无风险目录不增加第二次确认。

## 复用与边界

- 复用 `AppDialog`、`focusContainment`、`plainroot-button`、现有文件移动 reducer、workspace gateway 和 Rust mutation service。
- `WorkspaceMoveRisk` 是跨 Rust/TypeScript 的稳定数据契约，不是持久配置或引用索引。
- 最终全量回归首次运行时暴露 `fs::delete` 仍使用“进程 ID + 时间戳”的旧临时目录命名，和仓库已建立的唯一测试目录规则不一致，一个回收站测试出现夹具路径失效。该既有测试隔离缺口已改为由 `TestDirectory` 提供唯一目录，同时向要求 canonical root 的删除服务传入规范化路径；没有放宽产品路径校验、修改删除逻辑或用重跑掩盖红灯。
- 本次没有新增依赖、数据库、SQL、seed、菜单、Tauri capability、产品环境变量、preferences/state/recovery schema 或初始化数据。
- 不扫描 Markdown 正文，不建立反向链接关系，不保证识别扩展名之外的图片，也不修改未打开文档。

## 验证

已执行并通过：

- `pnpm typecheck`
- `pnpm test`：Node 独立回归 30/30、Vitest 23 个文件 176/176、Rust 180 项通过且 1 项手动性能探针忽略。
- `pnpm build`：入口 443.88 kB、排版 chunk 337.06 kB、源码 chunk 544.41 kB；源码 chunk 的既有 500 kB 告警未变化。
- `pnpm test:licenses`：4/4。
- `pnpm licenses:check`：727 个 Node 包、508 个 Rust 包、0 个阻断项。
- Rust fmt、all-targets/all-features Clippy `-D warnings` 和 all-features tests。
- `pnpm tauri build --no-bundle`。
- `pnpm test:e2e`：真实 macOS Tauri/WebKit 9/9。新增用例在临时工作区创建图片，验证风险 IPC、可见提示、取消，并确认原目录和 Markdown 仍可读取。

定向测试同时覆盖：

- 配置资源目录与嵌套图片命中。
- 无图片目录不提示。
- 超过检查预算时保守提示且不声称发现图片。
- 风险目录必须二次确认，第一次提交不调用移动。
- 取消不调用移动；无风险目录直接沿用原移动提交。
- Rust↔TypeScript interface parity 总守卫通过。

## 未验证与回滚

- T33 后续已随当前 HEAD `914ad8413b30569ab1c704dc1a55f15d3ed78c59` 推送；GitHub Actions run `30082725332` 已在 macOS/Windows 通过包含目录风险确认/取消的 9/9 桌面套件、非桌面门禁、未签名生产构建和 artifact 上传。WebView 自动化仍不替代原生系统输入与 Windows 原生 UI 人工验收。
- Windows 原生系统 UI、系统辅助技术、网络卷、休眠、文件系统卸载和超大目录长时行为未执行。
- 新桌面 E2E 验证了风险确认与取消零副作用；“继续移动”由组件测试覆盖，最终磁盘移动仍由既有 Rust CRUD 集成测试覆盖。
- 回滚 T33 只需同时移除风险命令、前端预检查和对应测试/文档；不涉及数据迁移，也不会自动恢复用户已经明确继续执行的目录移动。

## 文档同步

- `requirement.md` 已同步 R2/R6、P1 页面功能点、验收表、阶段状态和确认记录；没有新增或改变 R 编号。
- `plan.md` 已新增 T33，并同步任务状态、两张需求映射、页面承接、验证、风险、已确认决策和发布边界。
- `architecture/desktop-foundation.md` 与 `architecture/markdown-document-editing.md` 已同步目录风险检查、当前文档改写和其他文档不批量改写的边界。
- `t32-stage-acceptance.md` 已增加验收后补强指针；`t28-image-assets-ui.md` 已澄清其只改写当前打开文档。
- `README.md`、`AGENTS.md` 只更新当前稳定能力和本地/远端证据边界。
- `DESIGN.md` 不需要更新：没有新增组件、token、布局、断点或通用交互规范；页面继续消费已登记的 `AppDialog`。
- `CLAUDE.md`、页面原型和页面开发流程不需要更新：没有新增独立协作规则、页面或通用开发流程。
- SQL、seed、数据库、菜单、capability、产品配置、环境变量、依赖和脚本不需要更新：实现未改变这些稳定事实。
