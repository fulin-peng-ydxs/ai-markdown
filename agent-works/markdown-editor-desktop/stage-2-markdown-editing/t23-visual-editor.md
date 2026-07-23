# T23 Milkdown 排版编辑 adapter

## 功能的详细需求

T23 对应 R3、R6、R30、R31 的第二阶段子集，目标是在不建立第二份 Markdown 内容、保存通道或撤销事实源的前提下，把 Milkdown 7.21.3 接入 T19 定义的统一 `EditorAdapter`/`DocumentSession` 契约。

本任务需要覆盖 CommonMark/GFM 常用结构、选择与语义锚点、格式和块级命令、有效选区上下文工具栏、纯文本/Markdown/富文本复制、安全富文本粘贴、只读、焦点、composition 分组、受控图片请求和异步生命周期。初始化失败、超大内容或高节点密度不能冻结页面，必须向上层返回明确源码模式降级。T23 只交付可嵌入组件和 adapter，P1 正式接线、保存状态、资源导入与文档相对链接换算分别由 T25/T28 承接。

## 功能开发的实际结果

- `MilkdownVisualAdapter.ts` 将 CommonMark/GFM、listener、clipboard、选择、锚点和命令映射为 `EditorAdapterDocument`/`EditorAdapterChange`，所有变更携带 generation/editVersion。
- `VisualMarkdownEditor.tsx` 提供可嵌入 P1 的连续纸面编辑组件。上下文工具栏只在有效选区出现，图片通过 `requestImage` hook 接收受控相对 `src`，组件不读取绝对路径或维护导入状态。
- `clipboard.ts` 从同一 ProseMirror selection 生成纯文本、Markdown 和富文本载荷；富文本粘贴只保留可表达标签，移除事件属性、危险 URL、主动/未知容器和外部图片。
- `editorAdapter.ts` 补齐标题、块、列表、链接、图片、表格、分隔线和 history 命令。Milkdown 不启用第二套权威 history，adapter 命令与 Cmd/Ctrl+Z/重做只回调统一 session。
- `visualEditorPolicy.ts` 实现无镜像字节缓冲的 UTF-8 计数和无数组拆分的非空内容行门槛：当前 `≤2 MiB 且 ≤2000 个非空内容行` 才进入排版模式；更大或更密集的文档在创建 Milkdown 前返回源码降级。
- 非空内容行是挂载前的保守安全代理：它会把超过门槛的长代码块也导向源码模式，但不会像空行块数代理一样漏掉紧凑列表/表格；性能采样只重算 UTF-8 字节数，不再重复执行复杂度扫描。
- `VisualMarkdownEditor.css` 只消费现有语义 token，正文使用 17px/1.76 和最大 800px 连续纸面，没有卡片化 Markdown 块或私有颜色。
- 浏览器实测发现并修复 StrictMode 异步创建竞态：已销毁 adapter 的晚到 `apply` 不再复活实例，每个 adapter 使用独立 mount host，组件清理自有 canvas。

当前未完成且不得外推：

- P1 仍展示统一 session 的只读内容，T25 才消费 `VisualMarkdownEditor`。
- T23 验证了 Chromium 中文 contenteditable 输入和 composition 事务分组，没有取得 macOS/Windows 系统输入法候选窗证据。
- 浏览器接口未提供可隔离的 JS heap 峰值，峰值内存与 WebKit/Windows 性能仍由 T30/T31 验证。
- T28 才实现图片选择、粘贴、拖放、导入确认，以及按当前 Markdown 文档所在目录计算相对链接。

## 功能开发的具体实施方案

1. adapter 创建时先执行字节数和块数门禁，再在组件自有 host 中异步创建 Milkdown；销毁时立即移除 host，并等待创建 promise 完成后清理晚到实例。
2. CommonMark/GFM schema 提供标题、段落、引用、列表、任务、代码、链接、图片、表格和分隔线。命令统一通过 adapter `execute` 暴露，`find/replace` 保留给 T24/T25。
3. listener 把 Markdown、选择和语义锚点转换成统一会话事务。compositionstart 生成单次 transaction group；输入延迟探针从首个文档事务计时到 listener 输出，不与 T19 session patch/hash 计时混写。
4. 外部 session 投影通过 `replaceAll(..., true)` 更新，使用 `lastAppliedMarkdown` 阻止回环；初次 load 不再被组件重复 apply。
5. session history bridge 拦截平台 undo/redo 组合键并回调上层，不启用 Milkdown history plugin，保持跨 visual/source 的撤销事实源唯一。
6. 剪贴板 rich HTML 使用白名单转换。图片标签不进入排版正文，避免绕过 T22/T28 的签名、大小、工作区授权和导入确认。
7. 页面开发遵循 `DESIGN.md` 与页面工作流；新增稳定组件已登记到 DESIGN 组件表。复用审查确认 `AppDialog`、`AsyncStatePanel`、`focusContainment`、工作台文件操作与 T23 职责不同，不做错误抽取。

性能校准事实：

- 普通约 100 KiB、100 段语料：Chromium 挂载 148.6 ms，输入到 Markdown 更新 225.6 ms；listener 固定包含约 200 ms 合并窗口。
- 约 100 KiB、5680 个短段落的极端语料：策略校准前挂载约 813 ms，单次更新约 7.8 秒。该结果证明字节门槛不足。初版空行块数代理在复核中被证明会漏掉紧凑列表/表格，现改为 2000 个非空内容行的保守门槛。
- 复核整改测试确认：低于 2 MiB 的 2001 项紧凑列表、2002 行紧凑表格都会在 Milkdown 分配前降级，LF、CRLF、CR 的非空内容行计数一致；空白行不增加复杂度。
- 5/20/64 MiB：测试确认在 Milkdown 分配前由 2 MiB 字节门槛拒绝，不执行冻结式挂载。

## 上线部署操作

本次无额外上线部署操作：

- 无 SQL、数据库 schema、seed 或迁移。
- 无产品环境变量、密钥、账号、远端服务或第三方配置。
- 无新增 Tauri capability、原生菜单、持久化配置或初始化数据。
- `package.json` 与锁文件依赖已在 T18 固定，本次未新增依赖。
- 回滚 T23 代码只移除尚未被 P1 消费的 adapter/组件，不修改用户 Markdown、app data、资源目录或恢复快照。

## 验证情况

已执行并通过：

- `pnpm typecheck`。
- `pnpm test`：12 个 Vitest 文件、93/93 通过；其中 T23 新增 22 个 adapter/组件/策略测试，新增覆盖剪贴板拒绝、资源请求异常、已挂载投影跨越性能门槛时移除陈旧正文，以及紧凑列表/表格与三种换行的行数门禁。
- `pnpm build`：生产前端构建通过，主 JS 251.87 kB（gzip 77.63 kB），CSS 22.27 kB（gzip 4.28 kB）。
- `pnpm test:licenses`：4/4。
- 加载 Rust 工具链环境后的 `pnpm licenses:check`：727 个 Node 包、508 个 Rust 包、0 个阻断项。首次非登录 shell 因 `cargo` 不在 PATH 失败，未冒充许可证结论；补齐环境后重跑通过。
- 生产 adapter CSS/TS/TSX 的 hex、rgb、rgba、gradient 扫描无命中。
- 真实 Chromium：CommonMark/GFM 排版、单实例、选区工具栏、加粗状态变化、Markdown 复制、中文输入、740px 无水平溢出、普通 100 KiB 性能和干净新会话零 warning/error。

未执行：

- Rust 单测、Clippy、Tauri 构建未在 T23 重跑，因为本任务未改 Rust、IPC、capability、菜单或 Tauri 配置；沿用 T22 的 167/167 与构建证据，不把它们写成本轮新证据。
- 桌面 E2E、真实 P1、系统 IME 候选窗、macOS WebKit/Windows WebView2、原生剪贴板和独立峰值内存未执行；分别由 T25/T30/T31 承接。
