# T24 CodeMirror 6 源码编辑 adapter

## 功能的详细需求

T24 对应 R10、R30、R31，并承接 R3 的统一内容边界。目标是在不建立第二份 Markdown、独立保存通道或 CodeMirror 内部权威 history 的前提下，把 CodeMirror 6 接入 T19 定义的 `EditorAdapter`/`DocumentSession` 契约。

本任务需要提供 Markdown 高亮、行号、括号匹配、当前文档查找替换、选择和滚动锚点、只读、平台撤销重做、composition 分组和可销毁生命周期。不支持语法、CRLF、CR 或 mixed 换行不能在源码编辑时被静默删除或统一成 LF。T24 只交付可嵌入的 adapter/组件；P1 编辑器壳、排版/源码模式切换和保存状态由 T25 继续承接，工作区全文搜索 R12 不在本任务范围。

## 功能开发的实际结果

- `CodeMirrorSourceAdapter.ts` 显式组合 Markdown language、行号、高亮、括号匹配、当前行、中文查找替换、只读和输入监听，没有使用会隐式引入内部 history 的 `basicSetup`。
- `SourceMarkdownEditor.tsx` 提供与排版组件一致的 `EditorSurfaceHandle`，只消费 `EditorAdapterDocument` 并发出带 generation/editVersion 的 `EditorAdapterChange`；外部 session projection 使用 annotation 阻止回环。
- `sourceTextProjection.ts` 分离 CodeMirror 内部 LF 文本与 raw Markdown。用户变更从 editor offset 反投影到 raw offset，新增换行沿用原文件首个换行风格，未触及的 CRLF、CR 与 mixed 分隔符保持原样；选择和锚点继续使用 raw Markdown 偏移。
- 撤销/重做快捷键和 `execute(history)` 只回调统一 session。adapter 不安装 CodeMirror history，浏览器原生撤销也被消费，避免第三个历史事实源。
- 当前文档查找/替换使用 CodeMirror search state 与中文 phrases；没有创建工作区索引、数据库、R12 菜单或假搜索结果。
- Markdown 语法本身对未知扩展保持宽容，adapter 只提供真实 parser 高亮和括号匹配，不伪造通用“语法错误”；T19 的 source-only/解析证据由 T25 模式切换壳消费。
- `SourceMarkdownEditor.css` 只消费既有语义 token，行号、选择、匹配括号、查找面板、只读和可见焦点均有非私有样式。
- 复用审查抽取 `EditorSurfaceHandle`、`documentMetrics.utf8ByteLength` 和 `editorAdapterTestDocument`，两种 adapter 不再复制命令 handle、UTF-8 计量或测试投影工厂。
- 新增 15 个专项测试：9 个 adapter、4 个 React 组件、2 个 raw/editor 投影测试。

当前未完成且不得外推：

- P1 仍显示统一 session 的只读 `<pre>`，T25 才消费 `SourceMarkdownEditor` 与 `VisualMarkdownEditor`。
- 隔离 Chromium PoC 验证的是直接中文输入，不等于系统输入法候选窗、macOS WebKit 或 Windows WebView2 证据。
- 5 MiB 源码测试证明当前 adapter 可挂载并输入，不代表 64 MiB 连续编辑、峰值内存或长时自动保存已经验收。
- 当前文档查找不构成 R12 工作区全文搜索；搜索菜单继续按阶段边界保持禁用。

## 功能开发的具体实施方案

1. 只直接引入 CodeMirror 的 `commands/language/search/state/view` 模块，避免 `basicSetup` 带入内部 history；这些版本已存在于锁文件，本次提升为显式直接依赖。
2. load/apply 都先校验 source selection。用户事务携带 generation/editVersion/composition group，外部投影标记为 remote/non-history 并禁止触发用户变更回调。
3. CodeMirror 内部始终编辑规范化 LF 文本；raw 投影记录原 Markdown 与首个换行风格，按 `ChangeSet` 的 editor offset 映射 raw offset 并逆序应用变更。公开选择、锚点和回传 Markdown 都使用 raw 坐标与原始文本。
4. 查找和替换使用 CodeMirror search extension，中文化查找、替换、上下一个、全词、正则与关闭语义；只读允许查找和选择，拒绝替换与 history 变更。
5. Cmd/Ctrl+Z、Shift+Cmd/Ctrl+Z 与 Ctrl/Cmd+Y 在 editor DOM 边界直接转发 session history 并阻止浏览器默认撤销；不调用 CodeMirror undo/redo。
6. 组件使用 refs 保持回调新鲜，readOnly 变化时重建配置，document projection 变化时 apply；卸载销毁 view、监听和 DOM。
7. 页面开发遵循 `DESIGN.md` 和页面工作流；新增稳定组件已登记到 DESIGN。P1 未接线，因此本轮浏览器证据来自隔离 PoC，不冒充产品页面验收。

## 上线部署操作

本次无额外上线部署操作：

- 无 SQL、数据库 schema、seed 或迁移。
- 无产品环境变量、密钥、账号、远端服务或第三方配置。
- 无新增 Tauri capability、原生菜单、持久化配置或初始化数据。
- `package.json`/`pnpm-lock.yaml` 只把已锁定的 CodeMirror 子模块提升为直接依赖；离线 frozen install 已通过，许可证清单仍为 727/508/0。
- 回滚 T24 只移除尚未被 P1 消费的 adapter/组件与直接依赖，不修改用户 Markdown、app data、资源目录或恢复快照。

## 验证情况

已执行并通过：

- `pnpm install --offline --frozen-lockfile --trust-lockfile`：锁文件与本地依赖一致。
- `pnpm typecheck`。
- T24/T23 关联专项：37/37。
- `pnpm test`：15 个 Vitest 文件、108/108；Node 侧许可证 4、永久删除 4、路径 3、树状态 18、fixture 1 均通过。
- `pnpm build`：生产前端构建通过，主 JS 251.87 kB（gzip 77.63 kB），CSS 22.27 kB（gzip 4.28 kB）。T24 组件尚未被生产 P1 引用，因此 CodeMirror 产品 adapter 未进入主入口包。
- `pnpm test:licenses`：4/4。
- 加载 Rust 工具链环境后的 `pnpm licenses:check`：727 个 Node 包、508 个 Rust 包、0 个阻断项。首次非登录 shell 因 `cargo` 不在 PATH 中止；补齐既有环境后重跑通过。
- CodeMirror/Milkdown 生产 CSS 的 hex、rgb、rgba、gradient 扫描无命中；CodeMirror 源码目录无 `basicSetup` 或内部 history 调用。
- 真实 Chromium 隔离 PoC：源码行号/高亮、中文查找面板、匹配选择、直接中文输入、1100×740 与 740×740 无页面或源码区域横向溢出；普通 457 B 文档本次挂载样例为 2.6 ms。

未执行：

- Rust 单测、Clippy、Tauri 构建未在 T24 重跑，因为本任务未改 Rust、IPC、capability、菜单或 Tauri 配置；不把 T23 以前的 Rust 证据写成本轮新证据。
- P1 真实接线、桌面 E2E、系统 IME 候选窗、macOS WebKit、Windows WebView2、64 MiB 连续输入与独立峰值内存未执行；分别由 T25/T30/T31 承接。
