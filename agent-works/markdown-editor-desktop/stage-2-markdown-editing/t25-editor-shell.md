# T25 统一编辑器壳与模式切换

## 功能的详细需求

T25 对应 R3、R10、R11、R30、R31，并承接 R5 的可见保存状态子集。目标是把 T19 的单一 `DocumentSession`、T23 的 Milkdown 排版 adapter 和 T24 的 CodeMirror 源码 adapter 组合为 P1 唯一生产编辑器，使排版/源码切换、撤销重做、格式命令、当前文档查找、选择与滚动锚点都围绕同一 Markdown 内容源工作。

模式切换前必须先取得当前 adapter 尚未异步上报的 Markdown、选择和锚点，避免刚输入就切换造成内容丢失。源码切回排版时必须重新评估当前内容；未知语法、mixed 换行、过大或高节点密度内容继续保留源码安全路径，陈旧解析结果不能覆盖更新后的会话。只读文档允许查看、选择、查找和不改变正文的模式投影，拒绝格式、历史和正文修改。空文档提示只存在于 UI，不能写入 Markdown。

本任务不实现自动保存、恢复/冲突/另存弹层、图片输入、多页签、大纲或工作区搜索；现有保存状态只显示 `DocumentSession` 的真实状态，不自行宣称磁盘已提交。

## 功能开发的实际结果

- `DocumentEditorShell.tsx` 已成为 P1 单文档编辑容器，组合两种 adapter、统一 session history、模式切换、兼容性重评估、格式/查找命令、指标回调与延迟加载回退。
- `EditorToolbar.tsx` 提供排版/源码、撤销/重做、H1/H2、加粗、斜体、引用、无序列表和当前文档查找；禁用、pressed、busy 与只读状态来自真实 session/adapter 能力。
- `SaveStatus.tsx` 将 `clean/dirty/saving/saved/save_failed/readonly/conflict` 映射为文字、结构和语义色共同表达，不以颜色作为唯一状态，也不创建独立保存状态。
- `remarkMarkdownParser.ts` 使用生产 `remark` + `remark-gfm` AST 识别 frontmatter、wiki link、自定义 directive、MDX module/component，并共同消费 T23 的 2 MiB/2000 非空内容行排版门槛。解析失败或 source-only 原因会保留源码模式。
- `EditorSurfaceHandle` 新增同步 `getMarkdown()` 与 `getAnchor()`；Milkdown 在未编辑时返回原始 session Markdown，在存在尚未通过 listener 上报的输入时同步序列化当前文档，CodeMirror 返回 raw 投影文本。模式切换因此不会依赖 React 回调是否已经到达。
- `documentSession.ts` 允许只读会话提交不改变正文的 mode/selection/anchor 投影，但继续拒绝正文和历史修改。
- `WorkspaceWorkbench.tsx` 已移除临时只读兼容性解析和 `<pre>` 阅读器，改由生产 parser 建立 session 并渲染 `DocumentEditorShell`；文件 writable 与工作区 writable 共同决定只读，底部状态栏显示当前文档字数/字符数。
- 工作台原“磁盘状态已同步”已收窄为“文件树已同步”，避免文档已经 dirty 时与编辑器的“未保存”状态形成虚假磁盘成功暗示。
- 两个 editor 使用 `React.lazy` 按模式加载。生产启动主包为 391.16 kB，排版 chunk 为 334.02 kB；源码 chunk 为 543.59 kB，仍有 Vite 单块大于 500 kB 告警，但不进入启动页首包。
- `vitest.config.ts` 将测试文件改为串行执行。原因是测试套件会挂载真实 Milkdown/CodeMirror，并包含 5 MiB 源码性能门槛；文件级并行会把 worker 竞争错误计入编辑器时延。测试内部仍按原契约运行，没有放宽断言或超时。
- 新增/更新测试覆盖生产 AST 兼容性、排版/源码往返、统一撤销重做、格式命令、当前文档查找、空态、只读投影、陈旧解析拒绝、adapter 初始化失败、刚输入即切换和 P1 密集列表源码降级。

当前未完成且不得外推：

- T25 没有接入安全写、自动保存、恢复快照触发、冲突/另存/资源弹层或窗口结算门禁，现有 dirty 状态尚不会自动落盘。
- 浏览器验证使用开发 PoC 中的生产组件，不是经真实 Tauri IPC 打开的 P1 工作区页面。
- 系统 IME 候选窗、macOS WebKit、Windows WebView2、真实 P1 桌面布局矩阵、64 MiB 源码连续输入与独立峰值内存尚未验证，由 T30/T31 承接。

## 功能开发的具体实施方案

1. P1 读取真实 Markdown 后继续通过 T19 的 `requestDocumentLoad` 和 generation/editVersion 陈旧保护建立唯一 session；解析证据改由生产 Remark/GFM parser 提供，而不是页面私有正则。
2. 编辑器壳将当前 session 投影为 `EditorAdapterDocument`。adapter 用户变更仍通过 `applyDocumentEdit` 提交，模式命令和快捷键的撤销重做只调用 session history。
3. 切换源码前同步调用当前 surface 的 `getMarkdown/getSelection/getAnchor` 并提交 source 投影；切回排版时先捕获当前源码，再异步解析。解析返回后同时比较切换 sequence、generation 与 editVersion，晚到结果不会应用。
4. 排版不安全时保留/切回源码并展示具体兼容性文字。大文档和密集列表/表格在创建 Milkdown 前降级，不留下陈旧 ProseMirror DOM。
5. 排版模式下“查找”先执行同一套安全切换，再打开 CodeMirror 当前文档查找；没有注册 R12 工作区索引、搜索结果页或全局搜索菜单。
6. 两种 editor 通过动态 import 独立成 chunk；`Suspense` 回退复用 `AsyncStatePanel`，不另造页面私有 loading 组件。
7. 样式只消费 `tokens.css` 语义 token。编辑 surface 自己承担纵向滚动，工具栏在窄宽度自身横向滚动，不让整页或正文画布产生水平溢出。
8. 最终实现与 T25 计划一致；新增的生产 AST parser 替代 T19 的行级兼容性近似，按需加载是为闭合首次把 adapter 接入生产入口后的包体风险。

## 上线部署操作

本次无额外上线部署操作：

- 无 SQL、数据库 schema、seed 或迁移。
- 无产品环境变量、密钥、账号、远端服务或第三方配置。
- 无新增 Tauri capability、原生菜单、Rust IPC、持久化配置或初始化数据。
- `package.json` 与 `pnpm-lock.yaml` 将锁文件中已有的 `remark@15.0.1`、`remark-gfm@4.0.1` 提升为生产直接依赖；部署时按现有 frozen lockfile 安装。
- 回滚 T25 只移除 P1 编辑器壳、生产 parser 和直接依赖，不修改用户 Markdown、app data、恢复快照或资源文件。

## 验证情况

已执行并通过：

- TypeScript 类型检查。
- T25/parser/session/workbench 关联专项：46/46。
- `pnpm test:ui` 对应的全量 Vitest（直接调用锁定的本地 Vitest 二进制）：124/124。
- Node 侧许可证策略 4/4、永久删除反馈 4/4、工作区路径 3/3、树状态 18/18、fixture 1/1。
- 许可证清单：727 个 Node 包、508 个 Rust 包、0 个阻断项。
- 前端生产构建：启动主包 391.16 kB（gzip 118.97 kB）、排版 chunk 334.02 kB（gzip 101.76 kB）、源码 chunk 543.59 kB（gzip 187.79 kB）；源码独立 chunk 保留大块告警。
- 生产 editor/workbench CSS 私有 hex、rgb/rgba 和 gradient 扫描无命中。
- 真实 Chromium 开发验证页：排版→源码→排版内容保留；输入“切换保护”后立即切换仍保留；700 px 编辑器壳 `clientWidth === scrollWidth`；干净新页面控制台没有 error。

未执行：

- 本轮未重跑 Rust 单测、Clippy、Tauri build 或桌面 E2E，因为 T25 未修改 Rust、IPC、capability、menu 或 Tauri 配置；不把 T22 以前的 Rust 结果写成本轮证据。
- `pnpm install --frozen-lockfile` 和聚合 `pnpm test` 入口本轮未取得完成证据：pnpm 在执行脚本前触发供应链元数据校验并需要访问当前不可达的 registry。已直接运行 `pnpm test` 所列全部本地测试组成以及锁定的类型检查、生产构建和许可证扫描；新增直接依赖的具体包记录已存在于锁文件。T31 仍需在干净 CI 环境重新验证 frozen install 和聚合脚本入口。
- 真实 Tauri P1、系统 IME、WebKit/Windows、桌面窗口尺寸矩阵、峰值内存和 64 MiB 连续输入未执行，不能外推为已通过。
