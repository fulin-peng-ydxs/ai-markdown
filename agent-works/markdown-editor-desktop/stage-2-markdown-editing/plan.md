# Plainroot 第二阶段开发计划

> 当前执行分支：`codex/plainroot-stage-2`
>
> 当前阶段：阶段 2——统一 Markdown 文档模型、排版编辑/源码编辑和完整单文档保存、恢复、冲突、图片资源链路
>
> 计划状态：已完成本地阶段验收及验收后业务补强（T18～T33 均已完成；已推送的提交 `71cab73070bce27ec59fc8e35c670680d6ee2021` 对应 GitHub Actions run `30063241410` 取得 macOS/Windows 完整 CI 双绿；T33 已取得本地 9/9 真桌面证据，未推送前不宣称其取得新的远端 CI）
>
> 需求编号规则：完全沿用 `requirement.md` 的 R1～R34，不新增、重排或改变 R 编号含义。

## 1. 需求来源与目标

- 需求文档：`agent-works/markdown-editor-desktop/requirement.md`。
- 上游闭环：`agent-works/markdown-editor-desktop/requirement-closure.md`。
- 第一阶段计划与验收：`agent-works/markdown-editor-desktop/stage-1-desktop-foundation/plan.md`、`t17-stage-acceptance.md`。
- 当前实现架构：`agent-works/markdown-editor-desktop/architecture/desktop-foundation.md`。
- 页面与设计依据：仓库根 `DESIGN.md`、`agent-works/markdown-editor-desktop/page-development-workflow.md`。
- 已完整读取的页面原型：
  - P1：`prototypes/markdown-workbench.html`；
  - P2：`prototypes/workspace-launcher.html`；
  - P3：`prototypes/theme-preset-studio.html`。
- 功能目标：在第一阶段真实授权、读取、安全写入、监听和窗口底座上，为每个窗口建立一个可验证的单文档编辑会话；接入 Milkdown 排版编辑和 CodeMirror 6 源码编辑；完成统一 Markdown 内容源、共同撤销栈、自动/手动保存、恢复快照、外部冲突、另存副本、图片资源目录及真实状态反馈。
- 第二阶段边界：
  - 重点实现 R3、R5、R6、R10、R11；
  - 承接 R1/R2 的离线编辑、文件读写、监听和资源文件集成子集；
  - 承接 R14 的“当前单文档”窗口关闭/根替换保护子集，阶段 3 再扩展到全部页签；
  - 承接 R30/R31 的编辑、保存、模式切换、冲突弹层和键盘/无障碍子集；
  - P1 从只读源码预览升级为真实单文档编辑器；P2 只承接恢复入口和回归，不新增通用设置页；P3 不注册、不开发。
- 本次不做：R4 大纲、R7/R8 完整主题和布局、R9 阅读、R12 搜索、R13 多页签、R15 主题工作室、R32 长文视觉定稿；不以隐藏开关、假按钮或占位任务模拟后续阶段能力。
- 阶段外需求处理规则：本文件是第二阶段专属计划。阶段外必须实现项采用“跳过 + 未覆盖/部分覆盖 + 后续阶段说明”登记，不预占未来任务编号；这不取消产品义务。
- 计划输出目录：`agent-works/markdown-editor-desktop/stage-2-markdown-editing/`。

## 2. 当前项目依据

### 2.1 工程与依赖事实

- 当前分支从第一阶段最新本地 HEAD 创建。仓库已有 Tauri 2.11.5、React 19.2.7、TypeScript 6.0.2、Vite 8.1.4、Node 24.11.1、pnpm 11.5.1、Rust 1.97.1，精确版本以清单和锁文件为准。
- T18 已把 Milkdown 与 CodeMirror 聚合依赖精确写入清单与锁文件；T24 为避免 `basicSetup` 隐式带入第二套 history，又把已锁定的 `@codemirror/commands@6.10.4`、`language@6.12.4`、`search@6.7.1`、`state@6.7.1`、`view@6.43.6` 提升为显式直接依赖；T25 将锁文件中已存在的 `remark@15.0.1` 与 `remark-gfm@4.0.1` 提升为直接依赖，作为生产兼容性解析器。完整依赖图已由仓库许可证门禁验证为 727 个 Node 包、508 个 Rust 包、0 个阻断项。
- Milkdown 官方能力采用插件化接入：CommonMark/GFM、history、clipboard、listener、upload；生产实现不得直接复制原型中的 `contenteditable`/`textarea` 演示逻辑。
- CodeMirror 6 负责源码高亮、行号、查找替换、括号匹配和源码选择；不建立第二份 Markdown 文件或独立保存通道。
- 选型依据：[Milkdown 官方文档](https://milkdown.dev/docs)、[Milkdown 插件说明](https://milkdown.dev/docs/plugin/using-plugins)、[ProseMirror Guide](https://prosemirror.net/docs/guide/) 和 [CodeMirror Markdown 官方仓库](https://github.com/codemirror/lang-markdown)。
- 第一阶段测试基线为 115 个 Rust 单测、3 个路径工具测试、18 个树状态测试、4 个永久删除反馈测试、35 个 React 测试、1 个 fixture 测试、4 个许可证测试和 4 个桌面 E2E。T18～T30 已逐步补齐编辑器、session/history、恢复、冲突、另存、资源后端、两种 adapter、保存、图片、页面状态和契约服务门禁；T31 又把桌面 E2E 扩为 8 条真实 Tauri/WebKit 用例，并使用每套件独立复制的临时工作区。当前本机门禁为 Rust 176 项通过、1 项手动性能探针忽略，Vitest 173 项、Node 独立回归 30 项和桌面 E2E 8 项通过。第二阶段不得删除、缩小或用重试掩盖这些基线来换取绿灯。
- 当前已推送 HEAD `71cab73070bce27ec59fc8e35c670680d6ee2021` 对应远端 run `30063241410`：macOS/Windows 均完成许可证、类型与前端、Rust lint/测试、8/8 桌面 E2E、未签名生产构建、校验和收集和 artifact 上传；两个平台的 Vitest 摘要均为 23 个文件、173 项通过。T31 最新代码提交及其首次双绿证据仍在任务 6.14 中单独保留。

### 2.2 已有代码与可复用能力

- `src/features/workbench/WorkspaceWorkbench.tsx` 当前已接入文件树、读取、CRUD、watch、窗口决策、真实 `DocumentEditorShell` 和 `DocumentSaveController`，并消费单一 `DocumentSession`、生产 Remark/GFM 兼容性解析、文档级陈旧读取保护、排版/源码 adapter、恢复快照、冲突/恢复/另存、图片资源、窗口结算意图、每窗口原生菜单状态和持续文档状态栏。
- `src/features/workbench/workbenchGateway.ts` 已封装读取、扫描、监听、CRUD、删除、定位、安全写、恢复快照和窗口结算命令；P1 的自动/手动保存统一消费现有 `safeWriteMarkdownFile`，不另建磁盘写入通道。
- `src/services/desktop/contracts.ts` 已定义 `FileRevision`、`MarkdownReadResult`、`SafeWriteResult` 和稳定错误码；Rust↔TypeScript parity 测试已经存在，新契约必须纳入同一防漂移机制。
- `src-tauri/src/fs/safe_write.rs` 已实现受授权根约束、双重修订校验、同目录临时文件、平台原子替换、清理日志和失败不破坏原文件；本阶段必须复用，不另写前端文件覆盖逻辑。
- `src-tauri/src/fs/watch.rs` 已区分应用自身和外部事件并对批次做有界合并；保存成功后由 Rust 登记自身写入，外部事件仍须通过修订再确认，不能只信事件来源。
- `src-tauri/src/state.rs` 的 `plainroot-state-v1.json` 只保存最近工作区和根窗口会话，上限 8 MiB。恢复正文和资源目录偏好不得无版本地塞入该文件。
- `src-tauri/src/menu.rs` 已为每个窗口保存编辑菜单状态，并只在聚焦窗口拥有可执行 `DocumentSession` 时启用保存、另存、撤销/重做、当前文档查找和排版/源码模式命令；启动页与无文档工作台会重置这些命令，后续阶段入口继续禁用。
- 可直接复用的运行时资产：`AppDialog`、`AsyncStatePanel`、`focusContainment`、`WorkspaceTree`、`workspacePath`、全局 `plainroot-button` 与 `tokens.css`；冲突、恢复、资源目录和另存对话框必须优先组合这些能力。

### 2.3 页面与设计事实

- P1 事实源是 `prototypes/markdown-workbench.html`。原型已承载文档工具层的“排版编辑/Markdown 源码”、中央编辑画布、保存状态和状态栏区域；原型中的页签、大纲、搜索、专注、阅读和分页仍隐藏或保持禁用。
- 原型未承载冲突、恢复、资源目录和另存副本弹层；这些不是从原型复制的既有布局，而是本阶段新增流程。其业务事实源为 `requirement.md` 5.5、5.6 和页面功能点 7.1.2，交互壳以现有 `AppDialog`、`AsyncStatePanel`、`focusContainment` 及 `DESIGN.md` 的弹层/状态规范为布局依据。
- 上述四类弹层不新增独立页面、复杂多区布局或新导航，现有页面功能点与通用弹层契约足以支撑拆解，因此当前不补画 HTML 原型；T27/T29 必须在实现前完成弹层信息层级、危险动作、焦点和关键窗口尺寸审查。若届时出现会改变流程或验收的布局歧义，暂停对应任务并补原型/确认，不能由实现自行决定。
- P2 事实源是 `prototypes/workspace-launcher.html`。本阶段只在真实恢复快照存在且对应根可恢复时提供入口；不复制 P1 编辑器，也不把恢复失败冒充工作区加载成功。
- P3 `prototypes/theme-preset-studio.html` 与本阶段无消费者，不创建路由、状态或空组件。
- 视觉、布局和状态优先级以 `DESIGN.md` 为准；原型颜色不是生产事实源。状态优先级继续遵循 `permission-denied > missing > conflict > error > unsupported > saving > loading > dirty > readonly > empty > ready`。
- 根页面不滚动；中央编辑容器承担纵向滚动；表格和代码块只在自身必要时横向滚动。阶段 4 才定稿 760～820 px 正文宽度与长文排版，本阶段只保证编辑器容器可用和现有 820/760 px 退化不回归。

### 2.4 已确认的阶段决策

- 排版编辑采用 Milkdown/ProseMirror，源码编辑采用 CodeMirror 6；两者只是同一 `DocumentSession` 的投影。
- “无损”指受支持结构往返后内容与语义一致，不承诺未编辑区域始终字节级一致；不支持的语法必须保存为原始片段，并可切到源码模式查看、编辑和保存。
- T18 是硬门禁：PoC 若无法满足语法、原始片段、中文输入、包体或许可证要求，停止后续编辑器集成并回到选型确认，不静默改成其他框架。
- 恢复数据独立保存：每个工作区/文档只保留最新快照，默认 7 天、最多 32 项、总量 128 MiB，超限最旧优先；不替代 `.md` 原文件。
- “另存副本”允许写到工作区外，但只能写入用户在原生保存对话框中明确选择的单个目标，不扩大工作区根权限。
- 图片默认写入工作区内 `assets/`；每工作区可在 P1 资源目录对话框修改和恢复默认值，目标必须始终位于授权根内。

## 3. 实施范围

### 3.1 必须实现与本阶段承接

| 需求编号 | 需求内容 | 第二阶段覆盖 | 开发状态 | 对应任务 | 验证方式 |
| --- | --- | --- | --- | --- | --- |
| R1 | Windows/macOS 本地优先桌面应用 | 在既有桌面壳内增加离线编辑、保存、恢复和另存；不重做安装/授权 | 已完成 | T18、T29～T32 | 第二阶段范围已验收；T31 取得 macOS/Windows 8/8 真 Tauri/WebKit/WebView2 E2E、生产隔离构建与 artifact，Windows 原生 UI 保持人工项 |
| R2 | 文件与目录管理 | 复用读取、watch、安全写并接入当前编辑会话、图片资源文件和目录图片移动风险确认；不改变磁盘先行语义 | 已完成 | T19、T21、T22、T26、T28、T30～T31、T33 | 第二阶段范围已验收；两个平台的临时工作区已完成打开、编辑、资源落盘、保存、重开、外部修改与恢复回归；T33 又在本地真 IPC 验证风险提示与取消零副作用 |
| R3 | 所见即所得 Markdown 编辑 | 完整纳入本阶段 | 已完成 | T18、T19、T23、T25、T30～T32 | 第二阶段范围已验收；macOS/Windows 真实桌面链路已验证排版/源码编辑、保存和重开，系统输入法候选窗仍待人工验证 |
| R4 | 当前文档大纲 | 阶段 6 实现；本阶段只提供增量内容事件，不渲染大纲 | 跳过 | - | 映射审查确认没有假大纲或占位任务 |
| R5 | 自动保存、恢复与外部冲突 | 完成单文档链路；多页签关闭检查由阶段 3 扩展，搜索索引异常协同由阶段 7 承接 | 已完成 | T19～T21、T25～T27、T29～T32 | 第二阶段单文档范围已验收；两个平台已覆盖外部修改内容安全、自动恢复快照和显式恢复，完整产品仍待阶段 3/7 |
| R6 | 图片粘贴、拖放与资源管理 | 完整纳入本阶段；目录移动增加可能断链提示，不建立跨文档索引 | 已完成 | T18、T22、T23、T28、T30～T33 | 第二阶段范围已验收；两个平台的 WebView `DataTransfer/File` 已贯通上传、确认、Markdown、保存和重开；T33 本地验证目录风险提示，原生选择器、系统剪贴板和 Finder/Explorer 拖入仍是人工项 |
| R7 | 中性主题与颜色语义 | 只消费既有 token，不在本阶段实现主题产品能力 | 跳过 | - | token 扫描只作为页面合规回归，不计 R7 完成 |
| R8 | 自适应与区域调宽 | 保留第一阶段 P1 窄窗抽屉；完整调宽/持久化由阶段 4 实现 | 跳过 | - | T31 回归现有 820/760 px，不新增 R8 完成声明 |
| R9 | 编辑/专注/分页阅读 | 阶段 6 实现 | 跳过 | - | 确认阅读入口隐藏/禁用且无假反馈 |
| R10 | Markdown 源码模式 | 完整纳入本阶段 | 已完成 | T18、T19、T24、T25、T30～T32 | 第二阶段范围已验收；真实 WebKit/WebView2 会话已切换源码并保存重开，系统 IME 仍待人工验证 |
| R11 | 操作与文件状态反馈 | 完成本阶段编辑、保存、恢复、只读、冲突、图片和目录移动风险异步状态 | 已完成 | T19～T33 | 第二阶段状态反馈范围已验收；风险检查只报告可证范围，系统辅助技术和原生系统输入仍待人工验证，后续阶段状态仍未实现 |
| R12 | 工作区全文搜索 | 阶段 7 实现；CodeMirror 文档内查找不等同 R12 | 跳过 | - | 映射与菜单审查，工作区搜索继续禁用 |
| R13 | 多文档页签 | 阶段 3 实现；本阶段每窗口只维护一个 `DocumentSession` | 跳过 | - | 确认未以单文档下拉或隐藏页签模拟 R13 |
| R14 | 一目录一窗口与多窗口生命周期 | 仅将当前单文档保存门禁接入关闭/当前窗口替换；阶段 3 扩展为全部页签 | 已完成 | T26、T29～T32 | 第二阶段单文档门禁范围已验收；系统关闭/应用退出人工链路和阶段 3 全页签结算仍未完成 |
| R15 | 颜色预设与实时预览 | 阶段 5 实现；P1 只消费当前 Neutral token | 跳过 | - | P3 路由/状态不存在，映射审查 |
| R30 | 核心命令键盘操作 | 编辑、撤销/重做、保存/另存、模式切换、查找和弹层焦点子集 | 已完成 | T23～T25、T27～T32 | 第二阶段键盘子集已验收；原生保存/另存快捷键、系统 IME 与 Windows 快捷键仍是人工项，页签/阅读/工作区搜索快捷键待对应阶段 |
| R31 | 无障碍基础 | 编辑器、保存状态、冲突/恢复/资源及移动风险弹层子集 | 已完成 | T23～T25、T27～T33 | 第二阶段无障碍子集已验收；移动风险继续复用共享焦点/关闭门禁，系统辅助技术、IME 候选窗和 Windows 原生人工证据仍待登记 |
| R32 | 长文阅读排版 | 阶段 4 定稿；本阶段只保证编辑器基础可读与不溢出 | 跳过 | - | 不把编辑器基础样式记为 R32 完成 |

### 3.2 可选增强

| 需求编号 | 增强内容 | 需求阶段处理状态 | 开发状态 | 对应任务 | 说明 |
| --- | --- | --- | --- | --- | --- |
| R16 | 导出 HTML/PDF | 后续建议 | 跳过 | - | 等阅读渲染与主题稳定后另立计划 |
| R17 | 本地历史版本与 Git 集成 | 后续建议 | 跳过 | - | 恢复快照只保留最新副本，不扩张成历史版本 |
| R24 | 固定页签与预览页签组合追溯项 | 后续建议 | 跳过 | - | 只保留 R33/R34 追溯，不直接开发 |
| R25 | 跨窗口拖拽页签 | 后续建议 | 跳过 | - | 等 R13/R14 稳定后处理 |
| R26 | Plainroot 预设本地导入导出 | 后续建议 | 跳过 | - | 等 R15 预设格式稳定 |
| R33 | 固定页签 | 后续建议 | 跳过 | - | 等阶段 3 基础页签稳定 |
| R34 | 预览页签 | 后续建议 | 跳过 | - | 等阶段 3 基础页签稳定 |

### 3.3 暂不实现

| 需求编号 | 内容 | 开发状态 | 跳过原因 |
| --- | --- | --- | --- |
| R18 | 双向链接知识图谱 | 跳过 | 首版不扩展为知识管理平台 |
| R19 | 云同步 | 跳过 | 不建立账号、服务端和在线冲突协议 |
| R20 | 多人实时协作 | 跳过 | 不引入协作协议或权限体系；不启用 Milkdown/Yjs 协作插件 |
| R21 | 插件市场 | 跳过 | 编辑器插件仅作为编译期产品依赖，不建立用户插件生态 |
| R22 | 手机端 | 跳过 | 目标平台仍为 Windows/macOS 桌面 |
| R23 | 任意文字任意颜色 | 跳过 | 不向 Markdown 写入私有颜色语法 |
| R27 | 同一窗口附加多个根目录 | 跳过 | 保持一目录一窗口授权边界 |
| R28 | 同一目录多个可写窗口 | 跳过 | 继续聚焦已有窗口，避免并发覆盖 |
| R29 | Obsidian 主题源码兼容层 | 跳过 | 与本阶段编辑器依赖无关 |

## 4. 技术方案

### 4.1 模块边界与目标结构

```text
src/
├── features/editor/
│   ├── documentSession.ts
│   ├── documentHistory.ts
│   ├── editorGateway.ts
│   ├── adapters/milkdown/
│   ├── adapters/codemirror/
│   ├── save/
│   ├── recovery/
│   ├── assets/
│   └── components/
├── features/workbench/
└── services/desktop/
src-tauri/src/
├── commands/editor.rs
├── editor/recovery.rs
├── editor/save_copy.rs
├── editor/assets.rs
├── preferences.rs
└── menu.rs
```

- `DocumentSession` 是当前窗口唯一的文档状态事实源；Milkdown 与 CodeMirror 通过 adapter 读取/提交变化，不彼此直接同步。
- Markdown 正文仍只以工作区 `.md` 为持久事实源；恢复目录是崩溃安全副本，偏好文件只保存资源目录等非正文配置。
- 前端负责编辑事务、用户意图、可观察状态和焦点；Rust 继续负责路径授权、磁盘 revision、原子写、恢复仓储、单路径另存、资源复制和平台能力。
- 新增抽象必须由 P1 真实消费。编辑器 adapter、保存控制器、恢复仓储和资源服务不得只建空接口。

### 4.2 统一文档模型和历史

`DocumentSession` 至少表达：

| 字段/状态 | 用途 | 生产/消费 |
| --- | --- | --- |
| `workspaceId`、`relativePath` | 文档身份 | P1、Rust 命令 |
| `markdown` | 当前统一 Markdown 内容 | 两个 editor adapter |
| `diskRevision`、`persistedContentHash` | 最近一次确认的磁盘基线 | 读取、安全写、冲突 |
| `sourceFormat: { encoding, lineEnding }` | 从 `FileRevision.encoding/lineEnding` 显式派生并随成功 revision 刷新的原文件格式基线 | 状态栏、安全写、另存策略 |
| `editVersion` | 拒绝陈旧异步结果 | reducer、保存控制器 |
| `mode: visual/source` | 当前投影 | 工具栏、菜单、adapter |
| `saveState` | `clean/dirty/saving/saved/save_failed/readonly/conflict` | 状态栏、窗口保护 |
| `contentSafety` | 内存/快照/磁盘的安全性说明 | 错误和冲突弹层 |
| `anchor` | 语义块、源码偏移和滚动位置 | 模式切换 |
| `history` | 与 adapter 解耦的可逆 Markdown patch | 撤销/重做 |
| `recoveryState`、`conflictEvidence` | 恢复和冲突证据 | 保存控制器、弹层 |

- 统一历史记录可逆文本 patch、事务分组、前后 hash 与选择锚点；不得按每次按键保存整份 64 MiB 文档。
- T19 的初始内存边界为每会话 8 MiB patch 数据或 500 个历史项，先到者触发最旧记录淘汰；单次 patch 自身超过预算时当前编辑仍成立，但该步不可撤销并以 `truncated` 暴露。该值是后续真实编辑器压测可校准的工程边界，不是正文大小上限。
- 当前 patch 计算、前后 hash 和撤销校验仍是 O(文档长度)，1 B patch 只证明历史存储有界，不代表 64 MiB 文档每次输入廉价。T19 本机单次探针为记录约 486 ms、撤销约 255 ms；该数据只用于暴露风险，不是跨机器产品阈值。T23/T26 必须分别记录真实 adapter 连续输入的每击延迟和保存链路开销，无法保持交互时明确降级 source-only/只读或改为增量算法，不能用 patch 字节数替代性能验收。
- `sourceFormat` 是 `diskRevision` 的只读显式投影，不是第二份可独立修改的事实；读取成功时从 Rust `FileRevision` 建立，原文件保存继续把 expected revision 交给 safe-write 以保留 UTF-8 BOM 与单一 LF/CRLF/CR 风格，保存成功后用返回 revision 一起刷新。`Mixed` 必须保持显式状态：若 T18 证明 adapter 无法保留逐行分隔，自动保存不得静默统一换行，只能保留源码安全路径或在首次写入前让用户明确选择统一风格。非 UTF-8 文件不进入可写 session，另存副本必须明确使用 UTF-8 输出策略。
- 两个 editor 内部历史不作为跨模式事实源；`Cmd/Ctrl+Z`、`Cmd/Ctrl+Shift+Z` 统一调用 `DocumentHistory`，adapter 只负责应用结果与恢复选择。
- 切换模式前先从活动 adapter 提交最新事务；目标 adapter 从同一 `markdown` 更新，切换失败保留原模式和内容。
- T18/T19 必须用语料和内存压力验证 patch 策略；若无法守住跨模式撤销或大文档上限，不进入页面集成。

### 4.3 Markdown 往返与编辑器门禁

- 支持语法语料覆盖段落、H1～H6、粗体、斜体、删除线、行内代码、围栏代码块、链接、图片、引用、有序/无序列表、任务列表、分隔线和表格。
- 支持结构采用 CommonMark/GFM schema；受支持语法允许规范化空白或标记写法，但重新解析后的内容与结构必须一致。
- frontmatter、HTML、自定义 directive、未知围栏信息和插件语法等未被 schema 识别内容必须进入原始片段节点或安全降级为源码模式，禁止静默删除。
- 对无法可靠映射回排版编辑的文档，默认仍可在源码模式编辑和安全保存；界面明确说明原因，不把解析失败当空文档。
- T18 记录依赖许可证、压缩前后包体增量、首开耗时、程序化中文输入、粘贴、焦点、100 KB/5 MB/64 MB 序列化/hash 边界及语法结构往返结果；真实 IME 和 64 MiB 编辑器挂载并未由 T18 证明，分别由 T23/T31 和 T23/T26 继续作为门禁。已验证项失败时任务状态改为“阻塞”，后续任务保持“待开始”。

### 4.4 保存、冲突、恢复和退出数据流

1. 读取成功建立 `diskRevision + markdown` 基线；只读、超大或不支持编码不进入可写状态。
2. 编辑事务先更新 `DocumentSession` 和 `dirty`，再按防抖计划快照/保存；手动保存和自动保存调用同一保存控制器。
3. 保存控制器调用现有 `safe_write_markdown_file`；只有 Rust 原子提交成功且返回新 revision 后，才转为 `saved/clean` 并清理匹配恢复快照。
4. watch 外部事件触发 revision 重读；干净文档可安全重载，脏文档或写入竞态进入 `conflict`，保留当前内存和快照。
5. 冲突弹层展示相对路径、磁盘修改时间、当前状态、内存/恢复安全性；提供“放弃当前修改并重新加载”“以当前内容覆盖磁盘版本”“另存副本”“保持当前内容”。
6. 覆盖使用 Rust 一次性确认令牌绑定 workspace、path、最新 disk revision 和当前内容 hash；确认时再次校验，磁盘又变化则重新进入冲突，不绕过 TOCTOU 保护。
7. 另存先由 Rust 打开原生保存对话框并返回一次性目标令牌和脱敏显示路径；确认写入只能消费该令牌，不能接收前端任意绝对路径。目标已存在时再次展示明确覆盖结果。
8. 关闭窗口、退出应用和当前窗口替换先请求当前 `DocumentSession` 结算；`saving/save_failed/conflict/dirty` 未解决时阻止动作。阶段 3 将相同门禁扩展为页签集合。

自动保存初始基线采用输入停止后 800 ms；为避免大文件持续全量序列化/写入，控制器必须支持尺寸分级候选值：`≤5 MiB` 为 800 ms、`>5～20 MiB` 为 2 秒、`>20 MiB` 为 5 秒。恢复快照通常在 dirty 后 2 秒更新，但 `>5 MiB` 文档连续输入期间最多每 10 秒落一份，并保持单飞/合并；手动保存、关闭/切换/退出等风险边界不因降频而跳过最终结算。阈值由 T18 的序列化/hash、T23 的真实编辑器/IME 和 T26 的磁盘写入与输入延迟证据共同校准，不写成不可变产品规则。

### 4.5 恢复仓储

应用数据目录新增独立版本化仓储：

```text
plainroot-recovery-v1/
├── manifest-v1.json
└── snapshots/<opaque-id>.md
```

`RecoveryEntryV1` 至少包含 `recoveryId/workspaceId/relativePath/snapshotFileName/baseRevision/contentHash/updatedAt/expiresAt/byteLength`。文件名使用不可逆 opaque id，不把绝对路径写进文件名；Unix 新文件权限为 `0600`。manifest 与正文快照都采用同目录临时文件和原子替换。

- 每个 workspace/path 只保留最新一份；最多 32 项、7 天、总量 128 MiB。32 项和 128 MiB 是同时生效的独立上限，不承诺大文档场景一定能保留 32 项；两个接近 64 MiB 的快照即可耗尽字节预算。
- 新快照写入前先清理过期项，再按最旧顺序清理“当前进程中没有活动 dirty session”的快照；不得为了给新快照腾空间而静默删除仍对应活动 dirty session 的最后安全副本。活动集合只保存在进程内，由 session 进入 dirty 时登记，在成功保存、显式放弃修改或窗口安全关闭后释放；进程退出后由磁盘快照承担恢复，不把内存登记写成另一套持久状态。替换同一文档快照时只在新文件原子提交成功后移除旧文件。
- 若活动快照已占满预算、单项不符合上限、磁盘空间不足或清理失败，本次快照返回明确的 `recovery_unavailable/recovery_capacity_exceeded` 类状态：编辑会话继续保留内存内容并维持 `dirty`，`contentSafety` 显示“仅内存安全”，提供立即保存/另存/重试；关闭或替换窗口仍执行保存检查，不能把快照失败当作可以安全关闭。
- 未知 schema 不覆盖；损坏 manifest 隔离备份后重建空索引，无法安全关联的正文快照不自动删除。
- 打开文件时只有快照 hash 与磁盘内容不同才提示恢复；用户可预览时间和原文件状态，选择恢复到编辑会话、忽略本次或删除该快照。
- 恢复只进入 `dirty` 编辑会话，不直接覆盖磁盘；成功保存后才删除匹配快照。
- P2 仅在可恢复工作区会话存在时显示恢复提示；单条失败不阻断其他工作区。

### 4.6 图片资源和工作区偏好

资源目录配置使用独立 `plainroot-preferences-v1.json`，按 `workspaceId` 保存 `assetDirectory`，默认 `assets/`。配置由 Rust 定义/校验/保存/读取，P1 对话框渲染和重置，图片导入服务消费。

- 目录必须是授权根内的规范化相对目录；拒绝绝对路径、`..`、符号链接越界和文件路径。
- 粘贴/拖放/系统选择图片后，前端只提交受限二进制与元数据；Rust 校验大小、声明 MIME 与文件签名，创建资源目录并用 `create_new` 生成不覆盖的唯一文件名。
- 首版支持 PNG/JPEG/GIF/WebP；SVG 和其他主动内容格式先作为不支持类型给出明确反馈，避免把脚本内容直接载入 WebView。该限制列入验收和后续评估，不静默改扩展名。
- 资源写盘成功后才在当前 `DocumentSession` 插入相对 Markdown 链接；插入失败时通过一次性 import token 仅清理本次新建的目标副本，不删除用户原始图片。
- 文档移动后的资源链接调整属于 R2/R6 联动：阶段 2 对“当前打开文档被移动”显示明确确认并在磁盘移动与内容改写都成功后提交；无法保证原子时保留原链接并提示人工处理，不静默批量重写其他文档。
- 移动已配置资源目录或递归包含 PNG/JPEG/GIF/WebP 的目录前，由 Rust 在当前授权根内执行最多 10,000 个目录项的有界风险检查。命中配置目录、图片扩展名或检查不完整时，P1 复用现有移动 `AppDialog` 提示“未打开 Markdown 文档中的相对图片链接可能失效”，用户必须选择“继续移动（链接可能失效）”或取消；取消不得触发磁盘命令。该检查不解析 Markdown、不声称发现具体引用，也不批量改写其他文档。

### 4.7 P1 页面技术实现

- 原型文件：`agent-works/markdown-editor-desktop/prototypes/markdown-workbench.html`。
- 页面类型：更新既有复杂桌面工作台，不新增平行编辑页面。
- 原型未承载流程：冲突、恢复、另存副本和资源目录弹层均为新增业务组合，以 `requirement.md` 7.1.2 和 `DESIGN.md`/现有 `AppDialog` 契约为事实源，不声称与原型存在逐像素对齐关系。
- 保留区域：原生窗口、左文件树、窄窗抽屉、工作区决策、文件 CRUD 和现有状态组件。
- 变更区域：中央只读 `<pre>` 替换为 `DocumentEditorShell`；文档工具层接入排版/源码、保存/另存和资源目录；状态栏接入模式、保存、字数、编码/换行和光标；新增冲突、恢复与资源对话框。
- 继续隐藏/禁用：页签、大纲、工作区搜索、阅读、专注、主题工作室和布局调宽。

| 页面功能点 | 对应需求编号 | 需求交互要点 | 技术实现 | 涉及组件/模块 | 数据/API | 状态与异常处理 | 对应任务 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 7.1.1 打开工作区与文件导航 | R1、R2、R6、R11、R31 | 选择文件后载入真实会话；磁盘操作成功后更新；风险目录移动前明确确认 | 复用 P1、树 reducer、watch、移动 `AppDialog`；Rust 有界检查配置资源目录和图片扩展名 | `WorkspaceWorkbench`、`WorkspaceTree`、`DocumentSession` | 既有 read/scan/watch/CRUD + `inspect_workspace_move_risk` | 检查中禁用重复提交；风险/检查不完整时先提示；取消不移动，失败保留原树 | T19、T21、T26、T29～T31、T33 |
| 7.1.2 排版编辑默认态 | R3、R5、R11、R30、R31 | 输入、格式化、撤销重做、保存 | Milkdown adapter + 统一 history/save controller | `DocumentEditorShell`、`VisualMarkdownEditor` | session change/save/recovery API | loading/empty/dirty/saving/saved/save_failed/readonly/conflict | T18、T19、T23、T25～T29、T31 |
| 7.1.2 源码编辑 | R10、R11、R30、R31 | 源码高亮、行号、查找替换、模式切换 | CodeMirror adapter，共享 markdown/history | `SourceMarkdownEditor` | session change/anchor | 解析失败自动提供源码；异常语法不丢失 | T18、T19、T24～T25、T30～T31 |
| 7.1.2 图片与资源 | R2、R6、R11、R30、R31 | 粘贴、拖放、选择图片、配置目录；资源目录移动风险确认 | Rust 资源导入 + P1 配置对话框 + editor insertion + 目录风险检查 | `AssetDirectoryDialog`、asset service、移动 `AppDialog` | preference/import/confirm/cancel + `inspect_workspace_move_risk` | 重名不覆盖；失败不插入断链；只读禁用；未打开文档只提示风险、不虚称引用命中 | T22～T23、T28、T30～T31、T33 |
| 7.1.2 保存与另存 | R5、R11、R30、R31 | 自动/手动同链路；另存；只读兜底 | safe-write controller + 原生 save target token | `SaveStatus`、`SaveCopyDialog` | safe-write/prepare-save-copy/confirm | 保存失败保留内容；目标覆盖需确认 | T20～T21、T26～T27、T29～T31 |
| 7.1.2 冲突与恢复 | R5、R11、R30、R31 | 重载、覆盖、另存、保持；启动恢复 | AppDialog 组合 + recovery repository | `ConflictDialog`、`RecoveryDialog` | inspect/prepare-overwrite/recovery CRUD | 完整证据、二次确认、焦点返回、单项隔离 | T20～T21、T27、T30～T31 |
| 7.1.3 自适应布局 | R8、R11、R30、R31 | 本阶段只保证编辑器嵌入后不破坏现有退化 | 复用 P1 CSS/抽屉；不做分隔条与偏好 | 现有 workbench shell | 无新增布局 API | 820/760 px 无溢出；完整 R8 未覆盖 | T29～T31 |
| 7.1.4 大纲/专注/阅读 | R4、R7、R9、R30～R32 | 本阶段不开发 | 入口隐藏/禁用 | - | - | 不输出假状态 | - |
| 7.1.5 全文搜索 | R12、R30 | 本阶段不开发；源码内查找只作用当前文档 | CodeMirror 内建查找不注册为工作区搜索 | `SourceMarkdownEditor` | 本地 editor state | 搜索菜单继续禁用 | T24、T29 |
| 7.1.6 多文档页签 | R5、R13、R30 | 本阶段每窗口单文档 | `DocumentSession` 设计可由阶段 3 容器化，但不渲染页签 | `DocumentSession` | 无页签仓储/API | 不伪造页签恢复 | T19、T32 |
| 7.1.7 其他目录与窗口 | R1、R5、R14、R30 | 当前单文档未结算时阻止关闭/替换 | 关闭意图握手 + save controller | window coordinator、P1 | close/replace intent + resolve | 失败/取消保留原窗口与内容 | T26、T29～T32 |

### 4.8 P2/P3 页面承接

| 页面功能点 | 对应需求编号 | 第二阶段处理 | 状态/异常 | 对应任务 |
| --- | --- | --- | --- | --- |
| P2 7.2.1 打开本地内容 | R1、R14 | 保持现有入口；打开初始文件后进入 P1 编辑会话 | 选择取消零副作用；编辑器初始化失败回到可恢复错误 | T29～T31 |
| P2 7.2.2 最近工作区 | R1、R14 | 保持现有列表；有恢复快照时仅显示非阻塞提示 | 快照损坏不阻断其他记录 | T20、T27、T30～T31 |
| P2 7.2.3 窗口会话恢复 | R5、R14 | 根恢复后查询本根快照；不恢复页签集合 | 单项恢复/忽略/删除；失败可重试 | T20、T27、T30～T31 |
| P3 7.3.1～7.3.3 | R7、R15、R31 | 阶段外，不注册页面或命令 | 不出现可操作假控件 | - |

### 4.9 组件资产闭环

| 页面/区域 | 运行时复用组件 | 布局/配置能力 | 配置字段/页面注册 | DESIGN/清单更新 | 真实消费与验证 | 对应任务 |
| --- | --- | --- | --- | --- | --- | --- |
| 冲突/恢复/资源/另存弹层 | 复用 `AppDialog`、`focusContainment`、`plainroot-button` | 新增业务组合，不复制焦点逻辑 | recovery/conflict/asset props，不新增路由 | 登记稳定独立职责组件 | P1/P2 真实消费，组件测试 | T27～T31 |
| 编辑状态 | 复用 `AsyncStatePanel` 的阻塞/加载语义；新增紧凑 `SaveStatus` | 新增 editor status 种类 | `saveState/contentSafety` | 同步状态契约 | 工具栏/状态栏消费，非颜色验证 | T19、T25、T29～T31 |
| 编辑器容器 | 新增 `DocumentEditorShell`，内部使用两个 adapter | 不创建通用后台表单 | `mode/readOnly/session` | 登记编辑器壳和 adapter 边界 | P1 唯一消费者、往返/E2E | T23～T25、T29～T31 |
| 资源目录配置 | 新增 `AssetDirectoryDialog`，复用 AppDialog | per-workspace 配置 | `assetDirectory=assets/`，不注册设置页 | 登记配置闭环 | P1 保存/读取/消费/重置 | T22、T28、T30～T31 |
| 路径处理 | 复用 `workspacePath` 仅处理前端相对路径显示；安全校验仍在 Rust | 不新增平行 util | 不涉及 | 无重复实现 | 重命名/移动/图片链接测试 | T22、T28、T30～T31 |
| 目录图片移动风险 | 复用既有移动 `AppDialog`、operation 状态与 gateway | 不新增弹层、token 或配置 | `WorkspaceMoveRisk` 只返回目录级证据 | 无新组件/token，DESIGN 无需登记 | Rust 有界检查 + P1 确认/取消 + 真 IPC E2E | T33 |

## 5. 需求与开发内容映射和开发状态

| 范围类别 | 需求编号 | 需求内容/来源 | 计划开发内容 | 对应任务 | 状态 | 偏差判断 | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 必须实现 | R1 | 双平台、本地优先 | 既有桌面壳内增加离线编辑/恢复/另存并做双平台回归 | T18、T29～T32 | 已完成 | 部分覆盖 | 第二阶段范围已验收；macOS/Windows 真 Tauri/WebKit/WebView2 8/8 与正式构建隔离通过，Windows 原生人工项尚未完成 |
| 必须实现 | R2 | 文件/目录管理 | 编辑会话接入读取、watch、安全写、资源文件和目录图片移动风险确认 | T19、T21、T22、T26、T28、T30～T31、T33 | 已完成 | 部分覆盖 | 第二阶段范围已验收；两个平台的独立临时工作区已完成读取、图片落盘、保存、重开、外部修改与恢复；T33 本地真 IPC 又验证风险提示和取消零副作用，尚无该提交的远端双平台结果 |
| 必须实现 | R3 | 所见即所得编辑 | Milkdown、统一模型、格式化、粘贴和往返 | T18、T19、T23、T25、T28、T30～T32 | 已完成 | 部分覆盖 | 第二阶段范围已验收；macOS/Windows 真桌面会话已验证排版/源码连续编辑、保存和重开，系统 IME 候选窗仍待人工验证 |
| 必须实现 | R4 | 大纲 | 暂不纳入 | - | 跳过 | 未覆盖 | 阶段 6 |
| 必须实现 | R5 | 保存/恢复/冲突 | 完整单文档链路和当前窗口门禁 | T19～T21、T25～T27、T29～T32 | 已完成 | 部分覆盖 | 第二阶段单文档范围已验收；两个平台真实 IPC 已覆盖保存重开、外部修改内容安全、自动恢复快照与显式恢复，阶段 3 全页签关闭检查仍待完成 |
| 必须实现 | R6 | 图片/资源 | 粘贴、拖放、选择、资源偏好、相对链接与目录移动风险提示 | T18、T22、T23、T28、T30～T33 | 已完成 | 部分覆盖 | 第二阶段范围已验收；两个平台 WebView 文件事件已贯通 Rust 上传/确认、相对 Markdown、保存和重开；T33 已在本地验证目录风险提示，不建立跨文档引用索引或批量改写 |
| 必须实现 | R7 | 主题颜色 | 只消费现有 token | - | 跳过 | 未覆盖 | 阶段 4/5 |
| 必须实现 | R8 | 布局调宽 | 只做现有响应式回归 | - | 跳过 | 未覆盖 | 阶段 4，不以 T31 回归冒充实现 |
| 必须实现 | R9 | 专注/分页阅读 | 暂不纳入 | - | 跳过 | 未覆盖 | 阶段 6 |
| 必须实现 | R10 | 源码模式 | CodeMirror、统一内容源、异常语法保留 | T18、T19、T24、T25、T30～T32 | 已完成 | 部分覆盖 | 第二阶段范围已验收；真实 WebKit/WebView2 会话已切换源码并保存重开，系统 IME 仍待人工验证 |
| 必须实现 | R11 | 真实反馈 | 编辑/保存/恢复/冲突/图片及目录移动风险全状态 | T19～T33 | 已完成 | 部分覆盖 | 第二阶段状态反馈范围已验收；风险提示只陈述可能后果与检查边界，不虚构引用命中；系统辅助技术与原生系统输入仍待人工验证 |
| 必须实现 | R12 | 全文搜索 | 暂不纳入 | - | 跳过 | 未覆盖 | 阶段 7；文档内查找不替代它 |
| 必须实现 | R13 | 多页签 | 暂不纳入 | - | 跳过 | 未覆盖 | 阶段 3 |
| 必须实现 | R14 | 多窗口生命周期 | 当前单文档关闭/根替换门禁 | T26、T29～T32 | 已完成 | 部分覆盖 | 第二阶段单文档门禁范围已验收；系统关闭/应用退出人工链路仍未完成，阶段 3 再扩展全部页签 |
| 必须实现 | R15 | 主题预设 | 暂不纳入 | - | 跳过 | 未覆盖 | 阶段 5 |
| 必须实现 | R30 | 键盘流程 | 编辑/保存/模式/当前文档查找/弹层焦点 | T23～T25、T27～T32 | 已完成 | 部分覆盖 | 第二阶段键盘子集已验收；原生保存/另存快捷键、系统 IME 和 Windows 快捷键仍是人工项，页签/阅读/工作区搜索快捷键待对应阶段 |
| 必须实现 | R31 | 无障碍 | 编辑器与本阶段弹层/状态子集 | T23～T25、T27～T33 | 已完成 | 部分覆盖 | 第二阶段无障碍子集已验收；T33 复用对话框焦点/关闭门禁，系统辅助技术、IME 候选窗和 Windows 原生证据仍待人工登记 |
| 必须实现 | R32 | 长文排版 | 暂不纳入 | - | 跳过 | 未覆盖 | 阶段 4 |
| 可选增强 | R16 | HTML/PDF 导出 | 暂不纳入 | - | 跳过 | 未覆盖 | 后续建议 |
| 可选增强 | R17 | 历史版本/Git | 暂不纳入 | - | 跳过 | 未覆盖 | 恢复快照不得扩成历史功能 |
| 暂不实现 | R18 | 双向链接图谱 | 不开发 | - | 跳过 | 一致 | 正式排除 |
| 暂不实现 | R19 | 云同步 | 不开发 | - | 跳过 | 一致 | 正式排除 |
| 暂不实现 | R20 | 多人协作 | 不开发 | - | 跳过 | 一致 | 不启用协作插件 |
| 暂不实现 | R21 | 插件市场 | 不开发 | - | 跳过 | 一致 | 正式排除 |
| 暂不实现 | R22 | 手机端 | 不开发 | - | 跳过 | 一致 | 正式排除 |
| 暂不实现 | R23 | 任意文字颜色 | 不开发 | - | 跳过 | 一致 | 正式排除 |
| 可选增强 | R24 | 固定/预览组合追溯 | 仅追溯 | - | 跳过 | 一致 | 子项 R33/R34 后续处理 |
| 可选增强 | R25 | 跨窗口拖页签 | 暂不纳入 | - | 跳过 | 未覆盖 | 后续建议 |
| 可选增强 | R26 | 预设导入导出 | 暂不纳入 | - | 跳过 | 未覆盖 | 后续建议 |
| 暂不实现 | R27 | 单窗口多根 | 不开发 | - | 跳过 | 一致 | 正式排除 |
| 暂不实现 | R28 | 同目录多写窗口 | 不开发 | - | 跳过 | 一致 | 正式排除 |
| 暂不实现 | R29 | Obsidian 主题兼容 | 不开发 | - | 跳过 | 一致 | 正式排除 |
| 可选增强 | R33 | 固定页签 | 暂不纳入 | - | 跳过 | 未覆盖 | 后续建议 |
| 可选增强 | R34 | 预览页签 | 暂不纳入 | - | 跳过 | 未覆盖 | 后续建议 |

## 6. 详细实施步骤与进度追踪

执行纪律：严格按依赖逐项推进，不连续实现多个任务；每个任务完成后同步本计划状态、实际落地、对应留痕和受影响文档，完成验证后单独创建本地提交，再进入下一任务。T18 门禁失败时不得继续 T19 以后任务。

### 6.1 任务 T18：编辑器依赖、许可证、包体与往返 PoC 门禁

- 状态：已完成
- 依赖：第一阶段 T1～T17；本计划已确认技术方案。
- 涉及文件/模块：`package.json`、`pnpm-lock.yaml`、`scripts/check-licenses.mjs`（复用数据驱动扫描，不修改规则）、`src/features/editor/poc/`、`tests/fixtures/markdown/`、构建统计脚本、`t18-editor-poc.md`。
- 目标：证明 Milkdown 7.21.3 + CodeMirror 6 能在当前 React/Tauri/WebView 技术栈内满足进入正式集成的最低门槛。
- 操作：锁定依赖；建立 CommonMark/GFM、原始片段、中文/英文、图片、表格和异常语法语料；验证解析/序列化、两个 editor 创建销毁、中文输入、剪贴板、焦点、100 KB/5 MB/20 MB/64 MB 边界、各尺寸序列化/hash 耗时、候选保存防抖阈值、压缩前后包体与首开耗时；验证既有许可证扫描能自动覆盖新依赖。
- 产出：可重复 PoC、语料清单、性能/包体/许可证报告、明确的通过或阻塞结论。
- 影响范围：前端依赖图和后续全部编辑任务；不改用户数据、菜单或正式 P1 入口。
- 边界与异常：PoC 不能通过 raw 片段保留、跨模式内容一致性、中文输入或许可证门禁时立即标记阻塞；不得为了通过而删除需求语法或放宽许可证规则。
- 验证方式：`pnpm install --frozen-lockfile`、`pnpm licenses:check`、`pnpm test:licenses`、PoC 专项测试、`pnpm build`、产物包体差异；macOS WebView 人工输入冒烟。
- 完成标准：所有硬门禁有可复现证据，依赖精确锁定，失败处理路径已验证；只有结论为通过才允许 T19。
- 实际落地情况：已精确锁定四个编辑器依赖，并在隔离的 `src/features/editor/poc/` 建立 Milkdown React/直接 adapter、CodeMirror、CommonMark/GFM/raw HTML/异常扩展语法语料、source-only 保留判定和构建统计脚本。7 个 PoC 测试覆盖 React 挂载销毁、粗体/斜体/删除线/链接/引用/有序列表/任务/代码/表格/图片结构往返、raw HTML 保留且不执行脚本、焦点/程序化中文插入/剪贴板、CodeMirror 生命周期和异常语法源码保留；jsdom 测试不宣称覆盖真实 IME。真实 Chromium 输入冒烟通过，macOS Tauri WebKit 605.1.15 已确认页面与两个 editor 可加载，但自动化中文按键未能写入 contenteditable，未取得 WebKit 人工输入证据。100 KiB/5 MiB/20 MiB/64 MiB 的 JSON 序列化与 SHA-256 探针均完成；编辑器依赖 chunk（排除既有 React）为 1,063,793 B / gzip 347,906 B，正式 P1 未导入 PoC，生产 JS 仍为 247.44 kB / gzip 75.91 kB。既有许可证脚本自动覆盖锁文件新增依赖，无需修改规则；`pnpm install --frozen-lockfile`、类型检查、全量前端测试、许可证 727/508/0、生产 Web 构建和 `pnpm tauri build --no-bundle` 均通过。结论：T18 已验证的依赖、结构往返、程序化输入、包体和许可证门禁通过，允许进入 T19；真实 IME、64 MiB 编辑器挂载和完整 WebKit/Windows 产品链路仍由 T23/T26/T31 验收，不能从本任务外推为 R3/R10 已完成。证据见 `t18-editor-poc.md`。

### 6.2 任务 T19：统一 DocumentSession、可逆历史和 adapter 契约

- 状态：已完成
- 依赖：T18。
- 涉及文件/模块：`src/features/editor/documentSession.ts`、`documentHistory.ts`、`editorAdapter.ts`、`editorGateway.ts`、`src/services/desktop/contracts.ts`、对应 Vitest/Node 测试。
- 目标：建立单文档唯一内容源、保存状态机、模式/锚点和跨模式撤销边界。
- 操作：定义 discriminated union；把 `FileRevision.encoding/lineEnding` 显式映射为 session `sourceFormat` 并规定保存成功后的刷新规则；以 Markdown AST/解析结果定义不支持语法判定，不能直接沿用 T18 的行级启发式分类器作为生产事实源；实现 generation/editVersion 陈旧结果保护；实现事务分组、可逆 patch、内存上限和选择锚点；规定 adapter 的 load/apply/focus/selection/change/command/destroy 契约；把读取结果转为 session，禁止旧文档异步结果覆盖新会话。
- 产出：纯 TypeScript 文档模型、reducer/history、adapter 接口、序列图和单元测试。
- 影响范围：P1 当前单文档状态；不建立页签集合或持久化正文副本。
- 边界与异常：64 MiB 文档不得因每次按键全量快照无限增长；切换文件/模式时陈旧事务被拒绝；不支持编码和超大文件保持只读/错误事实。
- 验证方式：状态转移、encoding/lineEnding 基线与成功 revision 刷新、UTF-8 BOM 和 LF/CRLF/CR/mixed 透传、patch 逆向、事务合并、跨模式撤销、陈旧 generation、内存预算和空文档测试；TypeScript 类型检查。
- 完成标准：同一内容只有一个 session 事实源，encoding/lineEnding 来源与保存刷新路径明确，所有状态均为可枚举 union，历史能跨 adapter 恢复内容与选择且无无限增长。
- 实际落地情况：已建立 `DocumentSessionState` 与 `DocumentSaveState` discriminated union，统一表达文档身份、generation、Markdown、磁盘 revision、`sourceFormat`、editVersion、模式、选择/锚点、保存、内容安全、恢复与冲突证据；P1 原只读文档状态已改为消费该 session，同一工作区内慢返回的旧读取不能覆盖后来选择的文档。`sourceFormat` 只从读取或成功保存返回的 `FileRevision` 刷新；UTF-8 BOM 与 none/LF/CRLF/CR/mixed 均有测试，mixed 在尚无明确规范化决策时强制 source-only。`DocumentHistory` 以最小可逆 patch、事务步骤组、前后 hash、跨模式选择和 8 MiB/500 项双上限工作，不保存逐次全文；64 MiB 文档追加单字符只占 1 B patch，但本机探针明确记录 O(n) 成本约为写入历史 486 ms、撤销 255 ms，性能仍由 T23/T26 门禁。生产兼容性分类器只消费 AST/解析诊断，不复用 T18 行级启发式；session 已提供绑定 generation/editVersion 的 compatibility 重评估，源码删除未知语法或规范化 mixed 换行后可解除 source-only，真实 Milkdown AST parser 由 T23 adapter 提供。`beginDocumentSave` 已在模型层拒绝第二个 in-flight requestId，T26 仍需实现控制器单飞。`EditorAdapter` 已定义 load/apply/focus/selection/change/command/destroy 边界，现有工作台 gateway 继承统一读接口；尚未创建 Milkdown/CodeMirror 实例、自动保存、恢复仓储、冲突或可见编辑控件。28 个专项测试与 1 个 P1 竞态回归通过，`pnpm test` 为 71/71、类型检查和生产 Web 构建通过。证据见 `t19-document-session.md`。

### 6.3 任务 T20：版本化恢复快照仓储与命令契约

- 状态：已完成
- 依赖：T19 的 session/revision 契约；复用第一阶段原子文件适配。
- 涉及文件/模块：`src-tauri/src/editor/recovery.rs`、`commands/editor.rs`、`error.rs`、`lib.rs`、`contract_test.rs`、`src/services/desktop/contracts.ts`、`editorGateway.ts`、恢复 fixture 和 `t20-recovery-store.md`。
- 目标：实现正文恢复数据的独立、版本化、原子、有界仓储。
- 操作：建立 `plainroot-recovery-v1/manifest-v1.json` 与 opaque snapshot；实现 list/get/upsert/delete/cleanup 命令；读取和删除正文快照均重校验 workspace 身份与当前授权，删除不能只凭可枚举的 snapshot id；提供当前进程活动 dirty session 的登记/释放契约以保护其最后快照，释放仅发生在成功保存、显式放弃或安全关闭之后；正文文件读写移出全局 manifest 互斥区，读取通过计数租约保护并发删除安全，manifest 原子提交与状态切换仍串行；按“过期→非活动最旧”顺序执行 7 天/32 项/128 MiB 清理；校验 workspace/path、baseRevision、hash、期限和容量；设置 Unix `0600`；处理未知版本、损坏 manifest、容量不足、原子写失败和残件。
- 产出：Rust `RecoveryRepository`、稳定 DTO/错误码、TS parity、启动清理和故障注入测试。
- 影响范围：本机 app data；不修改工作区 Markdown，不变更 `plainroot-state-v1.json` schema。
- 边界与异常：7 天/32 项/128 MiB 三重上限；容量指标彼此独立；活动 dirty session 的最后快照不可被清理；无法持久化时返回“仅内存安全”而不阻断编辑；单项损坏隔离；未知 schema 不覆盖；没有授权根时只能展示脱敏元数据，不能自动读取原文。
- 验证方式：临时 app data 测试原子提交、崩溃残件、两个 64 MiB 级快照耗尽预算、第三个活动快照降级、非活动最旧清理、活动快照保护、成功保存/放弃/安全关闭后释放并恢复可淘汰、跨工作区删除拒绝、并发读取租约延迟物理删除、瞬时写失败后的运行期重试恢复、仅内存 contentSafety、过期、重复路径替换、损坏/未知版本、权限失败、非 UTF-8 路径和 Rust↔TS parity。
- 完成标准：失败不破坏上一份有效快照，清理有界且不误删 Markdown/活动会话最后快照；容量不足时可观察地降级为仅内存安全，所有命令可由 P1/P2 消费。
- 实际落地情况：已新增独立 `plainroot-recovery-v1/manifest-v1.json` 与 `snapshots/` 仓储，不改变 `plainroot-state-v1.json`。`RecoveryRepository` 以每工作区/相对文档唯一项保存最新快照，正文先在全局 manifest 锁外写入 `0600` opaque 新文件并同步，随后在锁内重新校验活动会话、容量与最新 manifest，再原子提交；manifest 失败会删除未提交新文件并保留上一份有效快照。大正文读取同样在锁外执行，并用按 snapshot id 计数的读取租约防止并发替换、清理或删除提前移走文件。仓储实现 7 天、32 项、128 MiB 三重边界，按过期后非活动最旧顺序清理，活动 dirty session 的最后快照在释放前禁止容量淘汰和显式删除；容量、未知版本或写入失败返回 `memory_only` 与稳定 issue，不把内存内容伪装成已恢复，`recovery_write_failed` 可由下一次成功写在运行期恢复为 Ready。启动时只清理 Plainroot 命名的普通孤儿/临时文件，损坏 manifest 条目会备份并保留其他有效项，单个缺失/损坏 snapshot 不阻断其他项，未知 schema 原文件不覆盖。已注册 list/get/upsert/delete/cleanup/register/release 七组命令，正文读取须同时匹配当前授权 workspace、snapshot id 与相对路径；删除命令还必须提交当前授权 workspace，仓储再次匹配快照所属 workspace，不能只凭 snapshot id 跨工作区删除。TS contracts、desktop service 和 `EditorRecoveryGateway` 已接入 parity，但 P1/P2 自动触发和恢复弹层仍由 T26/T27/T29 消费。21 个 T20 Rust 测试覆盖原子故障、活动保护、读取租约、运行期写失败恢复、跨工作区删除拒绝、两个 64 MiB 级容量边界、过期/最旧清理、身份绑定、损坏/未知版本、孤儿、权限与非 UTF-8 安全失败；Rust 全量 136/136、Clippy、fmt、TypeScript、前端全量 71/71、构建和许可证 727/508/0 通过。证据见 `t20-recovery-store.md`。

### 6.4 任务 T21：冲突证据、一次性覆盖令牌和安全另存副本

- 状态：已完成
- 依赖：T19、T20；复用 safe-write、dialog 和路径模型。
- 涉及文件/模块：`src-tauri/src/editor/save_copy.rs`、`commands/editor.rs`、`fs/safe_write.rs` 的受控扩展、`error.rs`、`lib.rs`、TS contracts/gateway、`t21-conflict-save-copy.md`。
- 目标：在不绕过 revision 和授权边界的前提下，支持完整冲突操作与工作区外单文件另存。
- 操作：新增磁盘证据读取；实现 bounded/TTL 的 conflict overwrite token，绑定 workspace/path/latestRevision/contentHash；实现原生 save target proposal 和一次性 save-copy token，并把后端可验证的源 `FileRevision.encoding/lineEnding` 绑定到提案：可编辑原文件的副本保留 UTF-8 BOM 和单一换行风格，`Mixed` 按已确认的本次格式决策处理，全新无基线内容使用 UTF-8 + LF；新文件 `create_new`，已有目标显式确认后原子替换；提交后消费令牌并记录 watcher 来源。
- 产出：prepare/confirm/cancel overwrite、prepare/confirm/cancel save-copy 命令，稳定错误码和集成测试。
- 影响范围：当前授权文件、用户明确选择的单个另存目标和进程内临时令牌；不新增持久目录授权。
- 边界与异常：目标在确认前变化、令牌过期/重放、符号链接替换、父目录失效、目标占用、写入中断、同名覆盖和取消均失败安全；绝对路径永不从前端直接作为写命令权威参数。
- 验证方式：TOCTOU、令牌重放、并发覆盖、工作区外单目标、UTF-8 BOM 与 LF/CRLF/CR 副本格式、Mixed 不静默规范化、无基线 UTF-8+LF 默认、原子失败、取消零副作用、Windows 占用和路径前缀测试。
- 完成标准：三种冲突决策和只读另存均有可执行后端契约，任何失败保持当前内容和原磁盘内容安全。
- 实际落地情况：已新增 `EditorSaveService`，以共享 workspace mutation lock 串行化冲突覆盖与另存提交，并将两类授权分别限制为最多 32 个、5 分钟有效、随机不可预测且确认时先消费的一次性令牌。冲突提案绑定当前授权 workspace、规范化根身份、相对路径、最新磁盘 `FileRevision` 与 Rust 计算的编辑内容 SHA-256；只读或不支持编码的磁盘文件仍返回可展示证据，但 `targetWritable=false`，确认覆盖继续由既有 safe-write 双重修订校验拒绝，不伪装可写。另存目标只由 Rust 原生保存对话框取得，前端确认命令只提交令牌、内容和显式覆盖布尔值；后端把目标绑定到规范化父目录身份、目标修订与格式决定，确认前后再次校验父目录、文件类型、符号链接和目标 revision。新目标使用 `create_new`/平台 no-replace，已有目标必须显式确认后通过同目录 `0600` 随机临时文件、同步、权限继承和平台原子替换提交；失败由 guard 清理临时文件并保留原目标。工作区源副本须匹配读取 revision；UTF-8 BOM 与单一 LF/CRLF/CR 可保留，mixed 或不支持编码必须明确选择 UTF-8 输出格式，全新无基线内容默认 UTF-8+LF。成功冲突覆盖以及落在源工作区内的副本会登记 watcher 自身写入，工作区外副本不会扩大根授权。Rust/TS 已新增 prepare/confirm/cancel overwrite 与 save-copy 契约、tag/enum parity 和稳定安全文案；16 个专项测试覆盖内容绑定、磁盘二次变化、只读、重放/过期/容量、并发单消费、源 revision 变化、工作区外目标、BOM/三种换行、mixed/非法编码显式格式、已有目标确认与 TOCTOU、父目录失效、符号链接换靶、故障注入和取消零副作用。全量 152/152 Rust（all-features 与 no-default-features）、71/71 Vitest、TypeScript、生产 Web 构建、fmt/Clippy、许可证 727/508/0 和 `pnpm tauri build --no-bundle` 通过。原生保存对话框真实点击、Windows 目标占用/扩展路径运行时和 P1 可见流程尚未验证，分别由 T27/T29/T31 承接；不得据此宣称完整 R5 已完成。证据见 `t21-conflict-save-copy.md`。

### 6.5 任务 T22：工作区资源偏好与图片导入服务

- 状态：已完成
- 依赖：T18、T19；复用 WorkspaceAccessService 和 mutation lock。
- 涉及文件/模块：`src-tauri/src/preferences.rs`、`editor/assets.rs`、`commands/editor.rs`、`error.rs`、`lib.rs`、TS contracts/gateway、图片 fixture、`t22-assets-backend.md`。
- 目标：闭合 `assetDirectory` 的定义、保存、读取、消费、重置和受控资源写入。
- 操作：建立 `plainroot-preferences-v1.json`；实现 per-workspace `assetDirectory` 默认/更新/重置；规范化根内目录；实现 PNG/JPEG/GIF/WebP 签名/大小校验、唯一命名、原子复制、import token 确认/取消清理和相对链接返回。
- 产出：版本化偏好仓储、资源命令、错误码/DTO、TS parity 和文件系统测试。
- 影响范围：app data 偏好和授权工作区资源目录；不读取或删除用户原始图片。
- 边界与异常：绝对路径、`..`、链接越界、目录不可写、同名、伪造 MIME、超限、部分写入和插入失败；SVG 明确拒绝，不静默改名。
- 验证方式：默认/保存/读取/消费/重置、损坏配置回退、路径攻击、文件签名、重名、权限、取消清理和并发导入测试。
- 完成标准：配置闭环有真实后端消费者，资源只写授权根内，成功结果始终返回可迁移相对路径。
- 实际落地情况：已建立独立的 `plainroot-preferences-v1.json` 偏好仓储，按稳定 `workspaceId` 保存 `assetDirectory`，默认 `assets/`；仓储限制 1 MiB/1000 个工作区，使用同目录私有临时文件、同步和平台原子替换，损坏配置先备份再回到安全默认，未知 schema 原样保留且拒绝覆盖，写入失败保持磁盘与内存旧值。资源目录由 Rust 解析为工作区相对路径，拒绝绝对路径、`..`、跨平台非法/保留名称、过长层级、已存在的文件节点和符号链接；get/set/reset 及导入前均以当前授权根重新校验。图片服务支持 PNG/JPEG/GIF/WebP，按二进制签名而非扩展名判定，明确拒绝 SVG，并固定 20 MiB 上限。Web 粘贴/拖放路径采用元数据绑定的一次性 raw IPC upload token，避免 JSON 数字数组放大；原生选择路径只由 Rust 系统选择器产生，源文件只读且永不删除。资源写入与文件操作共用 mutation lock，在根内创建资源目录，使用 `0600` 随机临时文件、同步和平台 no-replace 唯一命名，成功返回工作区相对路径并登记 watcher。落盘后签发最多 32 项、5 分钟、单次消费的 import token；编辑器插入成功后 confirm 保留文件，插入失败或取消时仅在文件身份、长度和 SHA-256 均未变化时删除本次新建副本，错误工作区不能消费令牌，正常进程释放和过期清理也遵循相同证据。Rust/TS 已补齐 8 个命令、DTO/tag/enum/error parity、前端 desktop service 和 editor gateway。15 个新增测试覆盖默认/保存/读取/重置、损坏/未知版本、原子失败、路径与 symlink、签名/MIME/SVG/超限、重名、部分写入清理、源文件保留、取消换靶、错误 workspace、令牌重放/容量/过期/并发和 raw IPC；全量 167/167 Rust 测试已通过。T22 没有 P1 页面消费者，真实系统图片选择器、WebView raw IPC 运行时、粘贴/拖放、Markdown 链接插入和 Windows 平台运行证据仍由 T23/T28/T31 承接；进程被强制终止在“资源已写盘、Markdown 尚未插入”窗口时可能留下孤立资源，当前不会冒险在下次启动猜测删除用户文件。

### 6.6 任务 T23：Milkdown 排版编辑 adapter

- 状态：已完成
- 依赖：T18、T19；T22 提供图片 hook 契约。
- 涉及文件/模块：`src/features/editor/adapters/milkdown/`、`VisualMarkdownEditor.tsx`、编辑器 CSS/token、语法/交互测试、`t23-visual-editor.md`。
- 目标：把确认通过的 Milkdown 方案接入统一 session，覆盖 R3 常用语法和排版编辑操作。
- 操作：配置 CommonMark/GFM、listener、clipboard、selection、输入规则和受控 upload hook；实现标题/粗斜体/删除线/代码/链接/引用/列表/任务/表格/分隔线命令，并为有效选区提供克制的上下文格式栏；支持按用户选择复制为纯文本、Markdown 或富文本，富文本粘贴只转换可表达结构，无法安全转换的内容提示或保留为受控原始片段；接入只读、焦点、选择锚点和 adapter 生命周期；单独记录 adapter 更新与 `DocumentSession` patch/hash 的每击延迟，不能只记录挂载或 patch 字节；所有样式消费语义 token。
- 产出：可嵌入 P1 的排版 editor adapter、格式命令和组件测试。
- 影响范围：P1 中央内容区；不实现主题、大纲、分页或协作插件。
- 边界与异常：初始化/解析失败回退源码；原始片段不可编辑时可见且提供源码入口；IME composition 中不触发错误自动保存；64 MiB 达不到可交互挂载门槛时必须进入明确的源码/只读降级，不能冻结页面；卸载不泄漏监听器。
- 验证方式：语法输入规则、格式命令、三种复制输出、粘贴纯文本/Markdown/富文本及不可转换结构、真实浏览器/WebView 中文 IME、撤销命令接线、只读、销毁重建、100 KiB/5 MiB/20 MiB/64 MiB 挂载解析/连续输入的每击延迟/峰值内存与降级阈值、token 扫描。
- 完成标准：真实 session 驱动排版编辑，常用语法可编辑并输出统一 Markdown，不存在独立保存副本。
- 实际落地情况：已在 `src/features/editor/adapters/milkdown/` 建立生产 `MilkdownVisualAdapter` 与 `VisualMarkdownEditor`。adapter 使用 CommonMark/GFM、listener 与 clipboard，只接受/输出 `EditorAdapterDocument`/`EditorAdapterChange`，不持有独立文件保存副本；撤销/重做及 Cmd/Ctrl+Z/重做通过回调交给统一 `DocumentSession` history，不启用 Milkdown 第二套权威 history。已实现 H1～H6、粗体、斜体、删除线、行内代码、链接、引用、有序/无序/任务列表、表格、分隔线和受控图片命令；有效选区才显示上下文工具栏，支持纯文本、Markdown、富文本三种复制载荷。富文本粘贴仅保留 CommonMark/GFM 可表达标签，移除事件属性、危险 URL、图片与主动/未知容器，外部图片必须走 `requestImage` 受控 hook；T28 再负责资源导入与按当前文档目录换算链接。只读、焦点、选择/语义锚点、异步创建/销毁、StrictMode 晚到实例清理和 adapter 性能采样均已落地。
  - 性能策略经真实 Chromium 校准为双门槛：UTF-8 内容超过 2 MiB，或非空内容行超过 2000，均在 Milkdown 分配前返回明确源码模式降级。普通约 100 KiB/100 段语料实测挂载 148.6 ms、输入到 Markdown 更新 225.6 ms（包含 listener 200 ms 合并窗口）；约 100 KiB/5680 段极端语料在策略校准前曾测得挂载 813 ms、单次更新约 7.8 秒。初版空行块数代理会漏掉紧凑列表/表格，复核整改后改为流式非空内容行计数；低于 2 MiB 的 2001 项紧凑列表和 2002 行紧凑表格均已前置拒绝。5/20/64 MiB 均由字节门槛前置拒绝，不冻结页面。
  - 新增 22 个 adapter/组件/策略测试，覆盖统一事务、结构命令、三态剪贴板载荷、剪贴板权限失败、富文本清洗、只读、session history 桥接、composition 分组、受控图片 hook 及其异常收敛、100 KiB 挂载、5/20/64 MiB 与高内容行数降级、紧凑列表/表格、LF/CRLF/CR 行计数、已挂载投影跨越门槛时移除陈旧正文、StrictMode 创建中销毁和组件卸载。`pnpm typecheck`、93/93 Vitest、生产构建、许可证 727/508/0 和生产 CSS 私有颜色扫描已通过。真实 Chromium 已验证单实例、格式变更、Markdown 复制、中文 contenteditable 输入、740 px 无横向溢出和干净会话零告警。
  - 尚未完成的范围保持诚实：T23 组件尚未替换 P1 只读视图，P1/session 保存接线属于 T25；T30 仅补生产往返与非桌面门禁，系统输入法候选窗、WebKit/Windows 原生剪贴板和独立峰值内存采样仍由 T31 验收，不能由 Chromium 证据外推。

### 6.7 任务 T24：CodeMirror 6 源码编辑 adapter

- 状态：已完成
- 依赖：T18、T19。
- 涉及文件/模块：`src/features/editor/adapters/codemirror/`、`SourceMarkdownEditor.tsx`、源码 CSS/token、测试、`t24-source-editor.md`。
- 目标：提供完整 Markdown 源码编辑、文档内查找替换和异常语法兜底。
- 操作：接入 Markdown language、行号、括号匹配、当前文档查找替换、语法问题定位/提示、selection/scroll anchor、只读 compartment、session/history command；平台快捷键遵循 CodeMirror 扩展与产品菜单契约。
- 产出：源码 adapter、查找 UI/命令和组件测试。
- 影响范围：当前文档源码视图；不建立工作区索引或 R12 搜索入口。
- 边界与异常：非法 Markdown 仍可编辑保存；大文档保持可输入；模式切换的外部同步不污染 adapter 内部历史；销毁释放 view。
- 验证方式：高亮/行号/查找替换/括号/键盘、异常语法、100 KB/5 MB 文档、只读、选择恢复和卸载测试。
- 完成标准：源码模式直接编辑统一 `markdown`，不支持语法不会被静默删除，文档内查找没有冒充工作区搜索。
- 实际落地情况：已在 `src/features/editor/adapters/codemirror/` 建立生产 `CodeMirrorSourceAdapter` 与 `SourceMarkdownEditor`，显式组合 Markdown language、行号、语法高亮、括号匹配、当前行、中文当前文档查找/替换、选择/滚动锚点、只读和生命周期，不使用会隐式安装内部 history 的 `basicSetup`。Markdown 本身允许未知语法，adapter 不伪造“通用语法错误”；source-only/解析证据继续由 T19 session compatibility 在 T25 切换时消费。平台撤销/重做与 `execute(history)` 都只回调统一 session，外部 projection 使用 annotation 阻止回环，所有用户变化携带 generation/editVersion/composition group。CodeMirror 内部只能使用单一换行符，故新增原始源码投影层：编辑区以 LF 规范化显示，但变更按原始偏移反投影到 raw Markdown，CRLF、CR 与 mixed 未触及部分不会被静默改成 LF，session 选择仍使用 raw Markdown 偏移。复用审查同时抽取 `EditorSurfaceHandle`、无分配 UTF-8 字节计数和 adapter 测试文档工厂，Milkdown/CodeMirror 不再维护第三份同职责工具。15 个新测试覆盖高亮/行号、异常语法、混合换行投影、真实查找替换、统一 history、composition、只读、外部投影、选择/滚动、5 MiB 输入、组件更新和销毁；`pnpm test` 108/108、类型检查、生产构建和许可证 727/508/0 通过。真实 Chromium 隔离 PoC 已验证中文输入、中文查找面板、匹配定位及 1100/740 px 无横向溢出。T25 已完成 P1 接线，T30 已补生产 source-only 往返门禁；系统 IME、WebKit/Windows 与桌面 E2E 仍留给 T31，不能由本任务外推为 R10 完整验收。证据见 `t24-source-editor.md`。

### 6.8 任务 T25：统一编辑器壳、模式切换、格式栏和跨模式历史

- 状态：已完成
- 依赖：T19、T23、T24。
- 涉及文件/模块：`DocumentEditorShell.tsx`、`EditorToolbar.tsx`、`SaveStatus.tsx`、document session/history、P1 接入测试、`t25-editor-shell.md`。
- 目标：在一个稳定容器内完成排版/源码切换、统一撤销、保存状态和空/加载/错误/只读呈现。
- 操作：组合两个 adapter；模式切换先提交再恢复语义锚点；从源码切换排版前对当前 editVersion 重新解析并调用 session compatibility 重评估，已删除未知语法或已规范化 mixed 换行时允许解除 source-only，陈旧解析结果拒绝应用；统一 undo/redo/format/find command bus；空文档使用 UI placeholder 而不写入正文；解析失败引导源码；暴露内容/字数/选择变化事件供后续大纲/search 消费但不实现消费者。
- 产出：P1 可消费的编辑器壳、命令总线、状态组件和交互测试。
- 影响范围：P1 中央区与文档工具层；不创建页签容器。
- 边界与异常：切换或 adapter 初始化失败保留旧模式；busy 时拒绝重入；跨模式 undo/redo 不丢 source-only 语法；只读仅允许选择/复制/查找/另存。
- 验证方式：visual→source→visual 语料往返、跨模式连续撤销重做、锚点、快速切换、空文档、解析错误、焦点和只读测试；接入时回归超过 2000 个非空内容行的紧凑列表/表格会切换源码降级且不残留陈旧排版正文。
- 完成标准：用户可在两个模式编辑同一内容，模式、状态和历史都来自同一 session。
- 实际落地情况：已新增 `DocumentEditorShell`、`EditorToolbar` 与 `SaveStatus`，由 P1 真实消费同一个 `DocumentSession` 和 T23/T24 两种 adapter；中央只读 `<pre>` 已替换为可编辑排版/源码表面。模式切换会先同步读取当前 adapter 的 Markdown、选择与锚点并提交 session，源码回排版再使用生产 `remark` + `remark-gfm` AST 解析器按 generation/editVersion 重评估兼容性；未知语法、mixed 换行、超过 2 MiB 或超过 2000 个非空内容行时保留源码安全路径，陈旧解析结果不会覆盖新内容。只读文档允许模式投影、选择和查找但拒绝正文修改；空文档 placeholder 只存在于 UI。两种 editor chunk 采用 `React.lazy` 按需加载，启动主包为 391.16 kB，排版 chunk 为 334.02 kB，源码 chunk 为 543.59 kB；源码独立 chunk 仍有 Vite 大块告警，但不再进入启动页首包。真实 editor 性能用例按测试文件串行执行，避免 5 MiB CodeMirror 与 Milkdown 实例并发竞争导致时间阈值失真。专项 46/46、全量 Vitest 124/124、类型检查、生产构建、许可证策略/清单及真实 Chromium 排版↔源码往返、即时输入切换、700 px 无溢出均通过。T30 已补非桌面生产往返与服务门禁；真实 Tauri P1、系统 IME、WebKit/Windows 与桌面 E2E 仍由 T31 承接。证据见 `t25-editor-shell.md`。

### 6.9 任务 T26：自动/手动保存控制器与窗口结算门禁

- 状态：已完成
- 依赖：T19～T21、T25；复用 window coordinator 和 watcher。
- 涉及文件/模块：`src/features/editor/save/`、workbench gateway/P1、`src-tauri/src/window.rs`、`menu.rs`、`lib.rs`、保存/关闭测试、`t26-save-lifecycle.md`。
- 目标：让自动保存、手动保存、模式风险边界、关闭窗口、退出和当前窗口替换共享一条可验证结算链路。
- 操作：实现尺寸分级防抖（候选为 800 ms/2 秒/5 秒）、单飞保存、pending edit 追赶、恢复快照单飞/合并与大文件 10 秒限频、manual save；控制器与 session 两层都不得用新 requestId 覆盖 in-flight 保存；处理 safe-write 返回、watch、revision 和状态；记录大文档 patch/hash 与写盘各自耗时，必要时合并输入、降频或触发明确安全降级；把 session dirty/clean/放弃/安全关闭转换为 T20 活动集合的登记/释放；切换当前文件、关闭窗口、当前窗口替换根目录前都走同一结算门禁；建立非阻塞 close/replace intent-id 握手，避免 coordinator mutex 横跨前端等待；接入应用退出多窗口结算。
- 产出：`DocumentSaveController`、窗口意图/确认命令、菜单事件、状态机与故障测试。
- 影响范围：当前窗口单文档、所有打开窗口的退出流程和当前窗口根替换；阶段 3 扩展到页签列表。
- 边界与异常：5/20/64 MiB 文档的写放大和输入延迟、保存中继续输入、快照容量降级、保存失败、冲突、窗口失效、前端无响应、重复 close、应用强制退出；未解决状态绝不关闭或替换，超时不自动放弃内容。
- 验证方式：fake timer、尺寸阈值/防抖/单飞/快照限频、5/20/64 MiB 写入次数和输入响应、保存期间编辑、失败重试、冲突、菜单/系统关闭、根替换、应用退出、多窗口和死锁回归。
- 完成标准：保存状态与磁盘提交点一致，所有正常关闭/退出/替换都经过结算且取消保持原状态。
- 实际落地情况：已新增 `DocumentSaveController`，按 UTF-8 字节数使用 800 ms/2 秒/5 秒自动保存防抖和 2 秒/10 秒恢复快照节流；保存与快照分别单飞，保存中继续编辑会在当前请求结束后追赶最新 `editVersion`，关闭结算等待追赶写完成，不会用新 requestId 覆盖 in-flight 结果。P1 的自动保存、工具栏手动保存、切换当前文件及对当前文件执行重命名/移动/删除均消费同一控制器；只有既有 safe-write 返回新 revision 后才清洁 session 并删除匹配快照，修订冲突保留内存内容和 T21 冲突证据，晚到快照不能在成功保存后复活。
  - Rust 新增 `WindowSettlementCoordinator` 与稳定 intent/resolution 契约。系统关闭、原生菜单关闭、当前窗口根替换和应用退出先发出非阻塞结算意图；前端仅在当前 session 可安全保存或已经干净时允许继续，拒绝或失败保持窗口、工作区绑定与持久根会话不变。重复关闭复用同一 intent，多窗口退出任一窗口拒绝即取消整组，coordinator mutex 不跨越前端等待。
  - 保存成功继续复用 Rust safe-write 的双 revision 校验、原子替换与 watcher 自身写入登记；恢复快照继续复用 T20 repository 的活动登记、版本/容量和 workspace 授权边界。没有新增数据库、SQL、seed、业务环境变量、capability、持久配置或菜单项；关闭窗口现有菜单改为进入结算链，`Cmd/Ctrl+S` 原生菜单仍由 T29 在有活动 session 状态桥后启用，避免悬空或按后台窗口状态错误启用。
  - fake timer 与组件测试覆盖尺寸阈值、UTF-8 计量、防抖、单飞/追赶、活动注册前置、快照节流、晚到快照、恢复失败不自旋、冲突、手动保存、切换/关闭结算；Rust 覆盖 close/replace/quit、重复意图、失效窗口清理、拒绝回滚、持久化失败与 Rust↔TypeScript parity。当前验证为 136/136 Vitest、171/171 Rust（另 1 项手动性能探针忽略）、类型检查、fmt、Clippy、前端生产构建和许可证 727/508/0。手动 safe-write 探针在本机 debug 测试路径测得 5/20/64 MiB 约 430/1650/5558 ms，说明 64 MiB 全量安全写仍是明确性能风险；分级防抖、单飞和追赶用于限制写放大，不把该结果表述为大文件保存无延迟。T29 只补了真实菜单/页面证据；系统关闭/退出、完整桌面 E2E、Windows 运行和强制进程终止仍由 T31 验证。证据见 `t26-save-lifecycle.md`。

### 6.10 任务 T27：冲突、恢复、只读和另存交互

- 状态：已完成
- 依赖：T20、T21、T25、T26。
- 涉及文件/模块：`src/features/editor/recovery/`、`ConflictDialog.tsx`、`RecoveryDialog.tsx`、`SaveCopyDialog.tsx`、P1/P2、CSS/token、测试、`t27-recovery-conflict-ui.md`。
- 目标：把 R5 的恢复和冲突证据转成明确、可取消、可重试、键盘可达的用户流程。
- 操作：复用 AppDialog/AsyncStatePanel；实现恢复列表/预览元数据、冲突四选项、覆盖二次确认、另存目标确认、只读另存和 contentSafety 文案；焦点返回触发点；单项失败隔离。
- 产出：三类稳定业务弹层、P1/P2 入口、组件测试和文案契约。
- 影响范围：P1 编辑会话和 P2 根恢复；不建立历史版本浏览器。
- 边界与异常：快照损坏/过期、原文件丢失或被外部删除、磁盘再次变化、令牌过期、目标覆盖失败、Esc/遮罩、processing 禁止关闭；外部删除时保留当前内容为恢复副本并提供另存或关闭，错误不使用 toast 承载长期恢复。
- 验证方式：组件交互、焦点圈定/返回、屏幕阅读器语义、破坏性动词、失败重试、取消零副作用和 contentSafety 文案测试。
- 完成标准：每个选择都触发真实状态变化；没有模糊“确定”或虚假成功，内容安全性始终可判断。
- 实际落地情况：已新增 `ConflictDialog`、`RecoveryDialog`、`SaveCopyDialog` 与共享 `ContentSafetySummary`，全部组合既有 `AppDialog`、`AsyncStatePanel`、`plainroot-button` 和语义 token。冲突弹层展示相对路径、磁盘修改时间/大小、当前 session 状态和内容安全位置；“准备覆盖磁盘版本”会重新取得一次性证据，并以“覆盖磁盘版本”完成第二次确认，令牌过期、磁盘再次变化或内容变化均保留当前内容并回到可重试选择。
  - 另存副本只通过 T21 原生保存目标 proposal/confirmation 链路执行；新目标与已存在目标使用不同明确动词，已存在目标必须“覆盖并保存副本”。只读文档、保存失败、冲突和外部删除均有真实另存入口；冲突或原文件缺失时使用 detached source 和明确 UTF-8 换行格式，不把过期源 revision 伪装为可保留基线。
  - P1 会按当前 workspace 查询恢复快照；快照 hash 与磁盘 revision 不同才提示。恢复读取完整快照后重新核对原文件和兼容性，只把内容载入唯一 session 并标记 dirty/recovery-safe，不直接写 `.md`。删除、损坏、过期或工作区失效按条目隔离。P2 只提供“打开工作区处理”入口，先复用最近工作区授权/窗口协调，再由 P1 完成内容恢复，不在启动页跨越授权边界写正文。
  - watch 观察到当前文档被外部删除时，session 转为 `save_failed/path_not_found` 并保留当前 Markdown；页面持续提供“另存副本”和“安全关闭文档”。关闭前必须已有覆盖当前 editVersion 的另存证据或持久恢复快照，否则拒绝关闭。成功冲突覆盖、明确放弃重载和恢复删除都按活动快照保护顺序释放/清理，不留下虚假成功。
  - 组件、session 与 P1/P2 接线新增 14 项 Vitest，当前总计 150/150；Rust 171 项通过、1 项手动探针忽略。类型、Vite 生产构建、fmt、Clippy、许可证 727/508/0 和 Node 独立门禁通过。浏览器临时验证页实际检查冲突四选项、覆盖二次确认和恢复弹层，发现并修复共享 dialog 宽度下的横向裁切；临时验证文件已删除。T29 未执行原生保存选择器、冲突/恢复桌面 E2E、Windows 或系统辅助技术，这些仍由 T31 承接。证据见 `t27-recovery-conflict-ui.md`。

### 6.11 任务 T28：图片粘贴、拖放、选择和资源目录交互

- 状态：已完成
- 依赖：T22、T23、T25。
- 涉及文件/模块：`src/features/editor/assets/`、`AssetDirectoryDialog.tsx`、P1 工具栏/编辑器 hooks、CSS/token、测试、`t28-image-assets-ui.md`。
- 目标：完成图片从用户输入到资源写盘再到相对 Markdown 链接的可回滚链路。
- 操作：接入 clipboard/drop/file-picker；显示资源目录、保存和重置；调用 import/confirm/cancel；后端返回的工作区相对 `assetPath` 必须以当前 Markdown 文档所在目录为基准转换为文档相对链接后再插入当前选择，不能直接把工作区相对路径写入正文；按编辑容器缩放显示但不修改原图，渲染缺失占位、原路径和“重新定位”入口；重新定位只在用户选择新资源并成功导入/校验后更新当前 Markdown 链接；当前文档移动时执行链接影响确认。
- 产出：图片交互控制器、配置对话框、缺失图片反馈和测试。
- 影响范围：P1 排版编辑器、当前文档内容和授权资源目录。
- 边界与异常：多图部分失败、重复文件名、超限/不支持格式、只读、资源目录失效、插入失败、拖放外部文件、缺失图片、工作区根文档与多层子目录文档；不得把失败文件写成链接，也不得混淆工作区相对资源路径和文档相对 Markdown 链接。
- 验证方式：PNG/JPEG/GIF/WebP 粘贴/拖放/选择、配置闭环、根目录文档与至少两级子目录文档的相对链接计算、路径分隔符规范化、重名、失败清理、键盘入口、缺失占位/重新定位和磁盘断言。
- 完成标准：资源先成功落盘再插入链接；写入正文的链接始终以当前文档目录为基准且可实际解析到导入资源，根目录和子目录文档均通过；重名不覆盖，配置可重置且真正被后端消费。
- 实际落地情况：已新增 `src/features/editor/assets/`，用统一路径代数把 Rust 返回的工作区相对 `assetPath` 转换为当前 Markdown 文档相对链接；根文档与多层子目录、空格编码、路径分隔符、越界和移动前后链接均有自动化覆盖。选择器、剪贴板与拖放都先调用 T22 导入 proposal，编辑器命令成功后才 confirm；插入失败、文档在异步期间变化或取消时调用 cancel，失败资源不会形成正文链接，多图逐项处理并反馈部分成功。
  - P1 新增资源目录工具栏入口和 `AssetDirectoryDialog`，继续复用 `AppDialog`、`AsyncStatePanel`、焦点返回、全局按钮与语义 token；读取、保存和恢复默认值均消费真实 per-workspace 偏好。只读文档禁用资源写入。
  - 排版与源码 adapter 共同支持在当前选择插入图片，并支持按拖放坐标恢复目标选择。Milkdown 图片节点只通过新 `read_workspace_image` 原始字节命令读取授权根内相对路径；Rust 重校验 workspace、路径、常规文件、20 MiB 上限和 PNG/JPEG/GIF/WebP 签名，前端生成可释放的 Blob URL，CSP 只增加 `blob:` 图片来源，不开放文件协议或通用文件 capability。缺失/不支持图片展示原路径与“重新定位”，只有新资源通过导入校验并成功更新节点后才确认保留。
  - 当前打开 Markdown 或其包含目录移动时，P1 显示默认勾选的本地图片链接调整项；磁盘移动成功后才基于旧/新文档目录和同移资源路径重写图片 URL，并将结果作为当前 session 的 dirty 编辑交给现有自动保存/恢复链，不在移动前改正文。
  - 图片导入共享单飞门禁，防止系统选择、粘贴和拖放并行消费不同 proposal；确认失败只在当前 session 仍停留于刚插入图片的 editVersion 时回滚该次插入，文档已有后续变化时不会误撤用户内容，并显示需检查链接的真实反馈。移动链接重写按 Markdown 图片目标语法定位 URL，不会因替代文本或标题与 URL 相同而改错字段。当前验证为 166/166 Vitest、172 项 Rust 通过（另 1 项手动探针忽略）、类型检查、fmt、Clippy、生产构建、Node 独立门禁和许可证 727/508/0。浏览器实际检查 1280/820/740 px 图片缺失态、资源目录输入/保存、焦点返回与横向溢出，发现并修复隐藏属性被 CSS 覆盖及对话框内部溢出；临时入口已删除。T29 未执行真实系统图片选择器、原生剪贴板/拖放或图片桌面 E2E，WebKit/Windows 与系统辅助技术仍由 T31 承接。证据见 `t28-image-assets-ui.md`。

### 6.12 任务 T29：P1/P2、菜单、状态栏和无障碍集成

- 状态：已完成
- 依赖：T25～T28。
- 涉及文件/模块：`WorkspaceWorkbench.tsx/.css`、`WorkspaceLauncher.tsx/.css`、`src-tauri/src/menu.rs`、`src/App.tsx`、`DESIGN.md`、组件测试、`t29-page-integration.md`。
- 目标：将第二阶段能力接入真实桌面页面，启用且只启用已有消费者的菜单/快捷键并维持视觉、响应式和无障碍规范。
- 操作：替换 `<pre>`；接入模式、保存、另存、资源目录、撤销重做、当前文档查找；状态栏展示模式/保存/字数/编码/换行/光标；菜单启用状态随 session/readOnly/busy 更新；P2 接恢复入口；登记新增稳定组件/token。
- 产出：可使用的 P1 单文档编辑工作台、P2 恢复入口、菜单事件和设计登记。
- 影响范围：P1/P2、原生菜单和全局样式；P3及后续命令继续不可用。
- 边界与异常：无文档、加载、只读、保存失败、冲突、权限、窄窗、低高度、菜单双触发和快捷键冲突；`Cmd/Ctrl+W` 仍留给阶段 3 页签，关闭窗口继续 `Cmd/Ctrl+Shift+W`。
- 验证方式：React 测试、菜单契约、键盘顺序、aria/live-region、token 扫描、1280/1050/820/740 和低高度浏览器/桌面检查。
- 完成标准：P1/P2 的所有本阶段控件均有真实行为，未实现入口隐藏/禁用，页面无私有颜色或额外根滚动。
- 实际落地情况：P1 已把当前 `DocumentSession`、`DocumentSaveController` 与编辑器运行忙态投影为每窗口 `EditorMenuState`；Rust 只对聚焦窗口应用保存、另存、撤销/重做、当前文档查找和排版/源码命令，窗口聚焦时恢复自己的状态，销毁时清理，P2 与无文档 P1 主动重置。剪切、复制、粘贴和全选继续使用系统原生角色，避免 WebView 与 React 重复监听同一加速键；工作区搜索、侧栏、阅读、页签和主题等无消费者命令仍禁用。
  - `DocumentEditorShell` 暴露受控 `execute/focus/switchMode` handle 和运行 busy 状态，原生菜单与工具栏因此消费同一命令通道，没有第二份编辑、保存或历史状态。新增 `DocumentStatusBar` 持续展示真实保存状态、排版/源码模式、字/字符数、UTF-8/换行、源码行列或排版选区语义及工作区可写性；只有活动反馈进入 live-region，窄窗优先保留保存/模式/活动状态。
  - 最新生产 `.app` 已在 macOS 真实打开脱敏 fixture：启动页保存/另存为禁用；无文档 P1 显示“未打开文档”；打开 `note.md` 后保存、另存、当前文档查找和模式菜单启用，撤销/重做按历史保持禁用；从原生“显示”菜单切换到 Markdown 源码后，同一编辑器和状态栏同步为源码模式、`12 字/词 · 84 字符 · UTF-8 · LF · 行 1，列 2`。验收只切换内存模式，未修改 fixture 正文。
  - 浏览器临时入口已验证 1280/1050/820/740 px 与 740×460 低高度：根页面无横向/纵向溢出，820 px 以下文件树退化为抽屉并将焦点交给关闭按钮，编辑器保留内部滚动，次要状态在窄宽度隐藏；临时入口已删除。生产 CSS/TSX 除统一 `tokens.css` 外没有私有颜色或渐变。
  - 本次新增菜单契约和状态栏/P1/P2 测试后，Vitest 168/168、Rust 174 项通过（另 1 项手动性能探针忽略）、Node 独立回归 30/30、类型检查、Vite 生产构建、macOS `.app` 打包、fmt、Clippy 和许可证 727/508/0 通过。没有新增数据库、SQL、seed、业务环境变量、持久配置或 capability。未执行阶段 T31 的隔离桌面 E2E、远端 Windows CI、Windows 原生菜单/辅助技术、系统 IME、真实图片剪贴板/拖放和长时峰值内存验证，不能外推为第二阶段或双平台验收完成。证据见 `t29-page-integration.md`。

### 6.13 任务 T30：契约 parity、单元测试与服务集成测试

- 状态：已完成
- 依赖：T18～T29。
- 涉及文件/模块：`tests/fixtures/markdown/`、`src/**/*.test.tsx`、Rust tests、`src-tauri/src/contract_test.rs`、`package.json` 单元/集成脚本、`t30-contract-unit-integration.md`。
- 目标：为统一模型、编辑器、保存、恢复、冲突和图片建立字段/枚举防漂移、纯状态单测和 Rust 服务集成门禁；桌面 E2E 与跨模块回归留给 T31。
- 操作：增加 roundtrip corpus、session/history、editor component、recovery/conflict/assets Rust 集成和故障注入；对所有新增 Rust DTO、tagged union、枚举值与字段名补 Rust↔TS parity；把稳定单元/集成脚本纳入 `pnpm test`。
- 产出：`test:editor`/`test:roundtrip` 等稳定脚本、脱敏 fixture、契约 parity、单元/服务集成测试和验证记录。
- 影响范围：本地与 CI 的非桌面测试时长和测试依赖；不改 E2E 驱动或生产运行时。
- 边界与异常：测试只用临时 workspace/app data，不读取用户目录；契约测试必须能通过注入字段/tag 漂移真实失败；不可用只改 snapshot 的方式掩盖行为回归。
- 验证方式：`pnpm test`、新增专项脚本、typecheck/build、Rust fmt/clippy/test、许可证；分别注入 DTO 字段、枚举值、save reducer 和 recovery 容量回归并确认测试如期失败后还原。
- 完成标准：新增契约没有自动防漂移空洞，核心状态与服务失败路径都有自动化断言，非桌面测试可在新 checkout 重复执行。
- 实际落地情况：
  - 已新增 `test:editor`、`test:roundtrip`、`test:rust` 稳定脚本，并让既有 `pnpm test` 统一执行 Node 独立回归、全部 Vitest 与无桌面 feature 的 Rust 服务测试；现有 CI 已调用 `pnpm test`，无需在 T30 修改 workflow，桌面 E2E 与双平台矩阵仍由 T31 承接。
  - 已用生产 `MilkdownVisualAdapter` 与 `CodeMirrorSourceAdapter` 建立 CommonMark/GFM、图片、受支持 raw HTML 和 source-only 原文的往返语料门禁；不再只依赖 T18 PoC 适配器证明生产链路。
  - `contract_test.rs` 新增全局登记守卫：`contracts.ts` 每个导出 interface 和字符串常量都必须在 Rust 测试源码中存在字段或枚举/tag parity 断言；图片选择 tagged union 又补充取消形状与 ready proposal 字段断言。
  - 修复既有安全写测试夹具只使用时间纳秒命名导致的并行目录碰撞。修复前默认全量 `cargo test` 在第 3 次复现两个 `SafeWriteUnavailable`；改用统一 `TestDirectory` 并增加 16 路并发唯一性测试后，默认全量命令连续 10/10 通过，未通过单线程或缩小范围掩盖。
  - 保存追赶测试从 fake timer 最终补偿收紧为首个写入完成后必须立即启动下一次写入，避免自动保存延迟掩盖追赶状态回归。DTO 字段、枚举值、保存追赶和 128 MiB 恢复容量四类故障注入均如期失败并已还原。
  - 最终本机验证：Node 独立回归 30/30、Vitest 171/171、Rust 176/176（另 1 项手动性能探针忽略）、`test:editor` 125/125、`test:roundtrip` 3/3、类型检查、生产构建、fmt、Clippy、默认全量 Cargo 测试及许可证 727/508/0 均通过。依赖未变化；`pnpm install --offline --frozen-lockfile --trust-lockfile` 已验证锁文件与本地依赖状态。未执行 T31 的桌面 E2E、远端 CI、Windows 或新增页面验证。

### 6.14 任务 T31：桌面 E2E、跨模块回归与 macOS/Windows CI

- 状态：已完成
- 依赖：T30。
- 涉及文件/模块：`tests/e2e/`、E2E runner/config、`package.json` 桌面脚本、`.github/workflows/ci.yml`、平台 fixtures、`t31-e2e-cross-platform-ci.md`。
- 目标：在 T30 契约/服务测试之上，完成 P1/P2 真 IPC E2E、第一阶段跨模块回归、macOS 实机和 macOS/Windows 远端门禁。
- 操作：扩展隔离桌面 E2E 覆盖打开→两模式编辑→保存→重开、冲突、恢复和图片；运行第一阶段 P1/P2/文件/窗口完整回归；本机 macOS 验证原生打开/另存/关闭、中文 IME、剪贴板/拖放、图片、冲突和恢复；CI 矩阵运行锁定工具链、全部非桌面测试、P1/P2 E2E 和生产构建；上传日志、截图和 artifact/hash。
- 产出：可重复桌面 E2E、跨模块回归记录、最新提交对应的双平台 run 链接、artifact hash、失败迭代和明确未验证项。
- 影响范围：E2E 测试依赖/时长、远端 CI 和测试产物；生产构建不得包含 fixture、WDIO 或 e2e-only 命令，不发布正式安装包。
- 边界与异常：E2E 单 worker、每套件隔离临时 workspace/app data；需要验证同一文档连续生命周期的步骤只在同一有状态 workflow 内串行，其他套件不得复用其磁盘或窗口状态。业务流程重试不得掩盖确定性失败；Windows 原生保存对话框、拖放、剪贴板、菜单和辅助技术若无法稳定自动化，必须保留人工未验证，不能用 macOS 或 WebView2 自动化外推。
- 验证方式：完整 `pnpm test`/Rust/typecheck/build/许可证回归、`pnpm test:e2e`、生产依赖/产物隔离、GitHub Actions macos-latest/windows-latest 双绿、macOS `.app` 人工清单和 Windows 平台适用 Rust 原子/路径测试。
- 完成标准：第一阶段和第二阶段跨模块链路均无回归，最新阶段提交取得真实双平台门禁证据；任何红灯修复后重新跑同一完整矩阵。
- 实际落地情况：
  - 已将桌面套件从 4 条扩展为 8 条，并把仓库 fixture 改为每套件独立复制的临时工作区；结束时回收临时目录，不再让保存/图片/外部修改用例触碰版本库 fixture。Mocha 确定性流程重试从 1 调整为 0，避免首次已经改变磁盘/窗口状态后由重试制造假绿；WebDriver 启动层仍保留独立的一次连接重试。
  - 8 条真实 Tauri/WebKit 用例覆盖 P2 真 IPC、1100/740 px 布局、入口焦点、临时 fixture 打开与初始 Markdown、排版与源码编辑、WebView `DataTransfer/File` 图片输入、Rust raw upload/confirm、保存与重开、恢复仓储 upsert/delete、外部磁盘修改后的本地内容安全与自动快照，以及显式载入恢复而不先覆盖源文件。
  - 真 IPC 暴露并修复三处此前单元测试未能穿透的跨层缺陷：恢复仓储曾把真实 `FileRevision.contentHash` 的 `sha256:` 前缀误判为非法；保存控制器在定时快照时重复注册已活动会话；Milkdown/CodeMirror 在 React 投影返回前的连续本地事务复用了旧 `editVersion`，且陈旧投影可能覆盖较新的 adapter 内容。Rust 现在分别校验带前缀 revision hash 与内部裸摘要，控制器复用已完成注册，两种 adapter 本地单调推进版本并拒绝同 generation 的低版本投影；均补有定向回归。
  - 本机 macOS arm64 已通过：`pnpm typecheck`、`pnpm test`（Node 30/30、Vitest 173/173、Rust 176/176，另 1 项手动性能探针忽略）、`pnpm build`、许可证 727/508/0、Rust fmt、全 feature Clippy/测试、`pnpm test:e2e` 8/8 和 `pnpm tauri build --no-bundle`。正式前端产物与 release 二进制扫描未发现 `PLAINROOT_E2E_DATA_DIR`、WDIO 或测试命令标记。
  - 本次没有修改数据库、SQL、seed、业务环境变量、正式 capability、菜单或持久配置；`.github/workflows/ci.yml` 已执行现有统一脚本并会自动消费新增 8 条套件，因此未为凑任务重复改写 workflow。
  - 提交 `2084489fa078cdcd02d640d0c00dd57971a9e0a2` 触发 run `30060302937`，Windows Rust lint 暴露 Unix 专用测试 fixture 未门控、Unix 权限字段在 Windows 未读取两处告警；修复提交 `11e3857fbdd0a9cc45ba908fef3923b71322d23a` 对应 run `30060937964` 已证明 Windows lint 与 Rust tests 通过，但桌面 E2E 又真实暴露 fixture 被 Windows checkout 转为 CRLF 后，测试仍固定按 LF 比较的跨平台假设。现已用 `#[cfg(unix)]` 收紧 Rust 平台边界，并把 E2E 的内容比较改为换行语义比较、外部修改沿用磁盘原换行风格；没有通过宽泛 `allow` 或测试重试屏蔽失败。
  - 最新代码提交 `bd583db452352c6410fbdaa8b05a68c2df122872` 对应 run `30062045288` 已完整双绿：macOS 6 分 12 秒、Windows 18 分 38 秒，许可证、类型与前端、Rust lint/测试、8/8 桌面 E2E、未签名生产构建、校验和与 artifact 上传均通过；macOS artifact digest 为 `75c830745bd3343aa8b6ae5b0ec9c7a5b0a3f90cc1fb876f51ed9a7308b24657`，Windows 为 `2733ae904da905b254f8c7cae09a8e8e56bbabb7ec39b23cf7c18842c8f6d9ef`。系统 IME 候选窗、原生保存选择器、系统剪贴板/Finder/Explorer 拖入、系统关闭/退出、峰值内存和 Windows 原生系统 UI 没有被 WebView 自动化替代。证据见 `t31-e2e-cross-platform-ci.md`。

### 6.15 任务 T32：第二阶段整体复核、架构文档和阶段验收

- 状态：已完成
- 依赖：T31。
- 涉及文件/模块：本计划、`requirement.md`、`architecture/`、`DESIGN.md`、`AGENTS.md`、`CLAUDE.md`、README、第二阶段留痕与验收文档。
- 目标：以代码和验证事实收口第二阶段，确保需求、计划、架构、约束和实现状态一致。
- 操作：逐项复核 R1～R34、P1/P2、任务状态、配置/菜单/权限/回滚、测试证据和未验证项；生成 `architecture/markdown-document-editing.md`；更新架构索引/入口；只把稳定长期规则写入 AGENTS/DESIGN/README；形成阶段验收报告。
- 产出：更新后的计划实际落地、需求阶段状态、技术架构文档、验收记录和本地提交。
- 影响范围：项目文档与下一阶段输入；不新增产品能力。
- 边界与异常：不得把单文档模型写成多页签完成，不把 CI 写成 Windows 原生人工通过，不把 PoC 值或临时缺陷流水账写入长期约束。
- 验证方式：代码/契约/文档交叉扫描、全部建议命令、Git diff/status、链接与任务编号一致性检查。
- 完成标准：所有已完成项有文件/接口/测试证据，未完成项仍诚实登记，阶段二最新提交可追溯且工作区干净。
- 实际落地情况：已逐项复核 R1～R34、P1/P2/P3、T18～T31、页面状态、菜单、权限、版本化恢复/偏好、回滚和未验证项；没有新增或改变需求编号。新增 `../architecture/markdown-document-editing.md` 作为统一会话、两种 adapter、保存/恢复、冲突、另存、图片和窗口结算的专项事实源，`../architecture/desktop-foundation.md` 保留跨模块底座概览并链接专项文档。需求阶段表、本计划两张需求映射、README 与 AGENTS 已同步为“第二阶段本地验收完成”，同时保持 R1/R2/R5/R11/R14/R30/R31 等跨阶段需求为部分覆盖，不把单文档门禁写成多页签完成。`DESIGN.md`、`CLAUDE.md`、原型、SQL/seed、capability、菜单、环境变量和产品配置无需因 T32 改动：本任务没有新增页面/组件/token、独立 Claude 规则、数据结构或运行能力。本机已通过冻结安装、类型检查、Node 30/30、Vitest 173/173、编辑器 127/127、往返 3/3、Rust 176/176（另 1 项手动探针忽略）、fmt、全 feature Clippy/tests、许可证 727/508/0、生产 Web 构建、macOS Tauri/WebKit 8/8 E2E 和 release 构建。完整结果、远端 run `30063241410`、artifact 摘要、文档更新与未验证项见 `t32-stage-acceptance.md`；T32 本地提交未推送前不宣称该提交取得新远端 CI。

### 6.16 任务 T33：目录图片移动风险提示

- 状态：已完成
- 依赖：T28 的图片相对路径与移动改写、T32 业务复核结论、用户确认的提示策略。
- 涉及文件/模块：`src-tauri/src/fs/mutate.rs`、`src-tauri/src/commands/files.rs`、`src-tauri/src/lib.rs`、`src/services/desktop/contracts.ts`、`files.ts`、`src/features/workbench/WorkspaceWorkbench.tsx`、`workbenchGateway.ts`、组件测试、桌面 E2E、本计划、需求/架构/验收/留痕与仓库稳定文档。
- 目标：在不建立跨文档引用索引、不虚构引用命中和不批量改写其他 Markdown 的前提下，避免移动资源目录或含图片目录时静默造成未打开文档断链。
- 操作：Rust 在授权根内检查被移动目录是否覆盖当前配置资源目录、是否递归含 PNG/JPEG/GIF/WebP，并以 10,000 个目录项为有界上限；前端在风险或检查不完整时复用当前移动 `AppDialog`，显示明确后果和“继续移动（链接可能失效）”，取消时不调用磁盘移动；无风险目录保持一次确认后直接移动。
- 产出：`WorkspaceMoveRisk` 稳定契约、`inspect_workspace_move_risk` 受控命令、P1 风险确认状态、Rust/React/真实 Tauri IPC 回归和 `t33-directory-image-move-warning.md`。
- 影响范围：只影响目录移动的提交前检查和反馈；不修改图片导入、资源偏好 schema、当前文档内联图片移动改写、普通文件移动或最终磁盘提交语义。
- 边界与异常：检查按扩展名识别目录级风险，不解析 Markdown 引用；符号链接不跟随；超过上限、偏好读取失败或扫描错误均保守提示但不得声称发现图片或具体引用；检查/取消/失败均不得更新文件树或磁盘。
- 验证方式：Rust 风险分类与有界失败测试、React 二次确认/取消/无风险直达测试、Rust↔TypeScript parity、完整 typecheck/test/build/fmt/Clippy/all-features/许可证/release 门禁，以及真实 Tauri IPC 创建临时图片后验证警告和取消零副作用。
- 完成标准：风险目录移动前必经明确确认；取消时磁盘无变化；无风险目录不增加多余步骤；全量本地门禁与 9/9 桌面 E2E 通过；文档不把本地结果写成新远端 CI。
- 实际落地情况：已完成上述实现。Rust 检查同时返回“配置资源目录受影响”“发现受支持图片”“检查是否受限”和最终 `mayBreakImageLinks`，命令仍先校验窗口的当前 workspace 授权；P1 在原移动对话框内增加检查中门禁和风险后果说明，没有新增第二套弹层或状态模型。组件测试锁定风险二次确认、取消零磁盘调用和无风险直接移动；真实 macOS Tauri/WebKit 第 9 条 E2E 通过临时图片验证命令、可见文案、取消和磁盘不变。最终全量回归还暴露 `fs::delete` 的旧时间戳临时目录未消费共享唯一目录工厂，已改为由 `TestDirectory` 持有夹具并向删除服务传入 canonical root，没有修改产品删除语义、放宽路径校验或以重跑掩盖红灯。本机最终通过 Node 30/30、Vitest 176/176、Rust 180 项通过/1 项手动探针忽略、类型检查、生产构建、fmt、全 feature Clippy/tests、许可证 727/508/0、9/9 桌面 E2E 和 `tauri build --no-bundle`。T33 未推送，Windows 与远端 CI 未执行，不得沿用 T31/T32 的 8/8 双平台绿灯作为本提交证据。

## 7. 数据库、SQL、配置、菜单、权限与初始化计划

### 7.1 数据库、SQL 与 seed

本阶段不涉及数据库、SQL 或 seed，不创建 SQL 文件。Markdown 内容继续位于用户工作区；恢复正文和资源偏好使用 Rust 管理的版本化文件。SQLite/FTS5 只在阶段 7 的 R12 计划中重新评估，不因 CodeMirror 的当前文档查找提前引入。

### 7.2 配置与本地数据路径

| 路径/配置 | 定义/保存/读取/消费 | 执行时机 | 影响范围 | 校验与失败 | 回滚方式 |
| --- | --- | --- | --- | --- | --- |
| `package.json`、`pnpm-lock.yaml` | T18 定义并锁定 Milkdown/CodeMirror；构建和 P1 消费 | 安装/构建/运行 | 前端依赖和包体 | 许可证、版本、peer dependency、生产隔离 | 回退 T18 提交并 frozen install；不影响用户文件 |
| `appDataDir()/plainroot-recovery-v1/manifest-v1.json` | Rust recovery 定义/保存/读取；P1/P2 消费 | dirty 后、风险边界、打开/启动、保存成功清理 | 本机恢复副本 | schema、hash、7 天、32 项、128 MiB、原子写 | 退出应用后可整体备份/删除；只失去未保存恢复能力，不修改 `.md` |
| `appDataDir()/plainroot-recovery-v1/snapshots/*.md` | Rust 写入/读取；用户通过恢复弹层决定是否载入 | dirty 快照与恢复时 | 可能含 Markdown 正文 | opaque 文件名、`0600`、manifest 绑定、大小/期限 | 同上；不得随代码回滚自动覆盖用户文件 |
| `appDataDir()/plainroot-preferences-v1.json` | Rust 定义并原子保存 per-workspace `assetDirectory`；asset service、P1 资源弹层和图片导入共同消费 | 应用 setup、读取/修改/重置配置、图片导入 | 本机非正文偏好；1 MiB、最多 1000 个工作区 | 默认 `assets/`、根内相对目录、非法/保留名和 symlink 拒绝；损坏备份回默认，未知版本保留且不覆盖 | 退出应用后删除恢复默认；不删除已导入资源 |
| `appDataDir()/plainroot-state-v1.json` | 继续由现有 state service 管理 | 应用 setup/窗口变化 | 最近工作区/根会话 | 本阶段不改 schema、不存正文或资源偏好 | 沿用第一阶段备份/删除回退 |
| `appDataDir()/plainroot-safe-write-cleanup-v1.json` | 继续由现有 safe-write 管理 | 每次原文件保存 | 安全写残件清理 | 现有 32 项、授权根与文件名校验 | 沿用第一阶段；不与 recovery 混用 |
| 进程内 conflict/save-copy/asset token store | Rust 定义、prepare 保存、confirm/cancel 消费 | 用户发起对应操作时 | 当前进程临时授权 | 随机、TTL、有界、一次性、绑定 hash/revision/目标 | 取消、过期或进程退出即失效；无持久授权 |
| `tests/fixtures/markdown/` | 测试语料，非初始化数据 | 自动化测试 | 仓库测试 | 脱敏、无用户绝对路径、覆盖 raw/图片/冲突 | 回退测试提交，不影响生产 |
| `PLAINROOT_E2E_DATA_DIR` | 现有 `e2e` feature 专用状态根 | 仅 E2E 构建/运行 | 临时测试数据 | 生产编译期移除；每套件独立清理 | 保持现有隔离；不得新增生产读取 |

本阶段无业务环境变量、账号、远程服务、API key 或初始化 seed。若实现中出现新的长期环境变量，必须先回到计划补充定义、消费者、默认值、泄露风险和回滚，不能只写代码。

### 7.3 菜单与快捷键

- 菜单定义继续集中在 `src-tauri/src/menu.rs`，通过现有窗口事件桥接到活动 `DocumentSession`；不得在 React 另注册一套会与原生加速键双触发的全局 keydown。
- T29 已新增并仅在真实会话可消费时启用：
  - 文件：保存 `Cmd/Ctrl+S`、另存副本 `Cmd/Ctrl+Shift+S`；
  - 编辑：撤销、重做、剪切、复制、粘贴、全选、当前文档查找 `Cmd/Ctrl+F`；
  - 显示：排版编辑 `Cmd/Ctrl+Alt+1`、Markdown 源码 `Cmd/Ctrl+Alt+2`。
- 上述菜单已在 macOS `.app` 验证启用态和模式动作；Windows 加速键冲突与原生菜单行为仍由 T31 验证，当前不能外推为双平台通过。
- 工作区全文搜索 `Cmd/Ctrl+Shift+F`、页签、阅读、专注和主题命令继续禁用；当前文档查找不得发送工作区搜索事件。
- 菜单启用条件由是否有活动 session、`readOnly`、`busy`、history canUndo/canRedo 和 mode 决定。未实现或不可执行命令保持禁用，不显示成功 toast。
- 关闭窗口继续使用 `Cmd/Ctrl+Shift+W`；`Cmd/Ctrl+W` 保留给阶段 3 的关闭页签。关闭窗口菜单必须进入 T26 保存结算门禁。
- 回滚：回退菜单项和事件消费者；没有消费者时同步恢复禁用，不能留下悬空加速键。

### 7.4 权限与能力注册

- 正式 Tauri capability 继续遵循最小权限：前端不获得通用 filesystem/dialog 写权限，所有磁盘动作通过 Rust 命令和运行时授权根。
- 原生保存/图片选择器由 Rust 侧调用现有 Dialog 插件；若现有 capability 无需变化则明确记录“无权限文件变更”。如必须增加命令 capability，只允许当前窗口标签和确切命令，不配置 `$HOME/**/*`。
- 另存副本只授权一次性单目标；图片资源只允许当前 canonical root 内的配置目录；恢复仓储只允许应用自己的 app data 子目录。
- 冲突覆盖、资源导入、恢复删除和配置写入都由 Rust 重校验，不信任前端 `confirmed=true`、MIME、路径或 revision 文本。
- 回滚：移除命令注册/capability/plugin 时同步移除 UI 入口；已成功保存的 Markdown/资源不随应用权限回滚静默改写。

### 7.5 初始化、兼容与迁移时机

- 应用 setup：初始化 recovery/preferences repository；未知版本只读阻断对应能力，不覆盖新版本文件；仓储故障不阻断安全查看已有 Markdown。
- 窗口/工作区绑定：读取 per-workspace 资源偏好，查询可恢复快照；没有文档时不创建空正文快照。
- 文档打开：比较 snapshot/content/disk revision 后决定是否提示；不自动把快照写回磁盘。
- 从第一阶段升级：`plainroot-state-v1.json`、safe-write cleanup 和根会话原样兼容；新增目录/文件缺失时按默认初始化，无 SQL/seed/migration。
- 版本回退：旧版本看不到新 recovery/preferences 文件但不得删除；用户若回退后继续编辑，恢复副本不自动消费。正式发布前需验证新旧版本并行不会覆盖未知 schema。

## 8. 测试与验证计划

### 8.1 单元测试

- 计划：覆盖 DocumentSession union、save reducer、generation、patch history、跨模式 undo、锚点、autosave debounce/single-flight、editor adapter 生命周期、配置校验、token 生命周期、恢复清理和错误文案。
- 具体完成情况：T19 已覆盖 session/history；T20 已覆盖恢复仓储；T21 已新增冲突/另存/契约测试；T22 已新增偏好、图片资源和 raw IPC 契约测试；T23/T24 已覆盖两种 adapter；T25 已覆盖生产 AST 兼容性与统一编辑壳；T26 已覆盖 autosave、恢复调度和窗口结算；T27 已覆盖恢复载入、冲突覆盖、另存、P1/P2 入口、外部删除保护和安全关闭；T28 已覆盖图片路径/签名、资源目录、选择/剪贴板部分失败、缺失重定位、单飞/确认失败回滚和移动链接确认；T29 已覆盖每窗口菜单状态、原生动作路由、状态栏内容和 P2 菜单重置；T30 增加生产 adapter 往返语料，并收紧保存中继续编辑必须立即追赶的断言；T31 增加两种 adapter 连续本地事务、陈旧投影和恢复活动注册复用回归；T33 增加目录风险二次确认、取消零调用和无风险直达组件测试。当前 Vitest 为 176 项。

### 8.2 接口与集成测试

- 计划：在临时 workspace/app data 中测试读取→编辑→safe-write→revision、外部修改→冲突、恢复 upsert/list/delete、另存单目标、资源导入/取消、窗口 close/replace intent；Rust↔TS 对所有新增 struct/tag/enum 做 parity。
- 具体完成情况：T20 已覆盖 recovery CRUD/授权；T21 已覆盖外部修改→冲突覆盖、工作区内外另存、一次性令牌、源/目标 revision 与 Rust↔TS parity；T22 已覆盖偏好仓储、资源导入/确认/取消、唯一命名、失败清理和资源 DTO/tag/enum parity；T26 已把读取→编辑→safe-write→revision/recovery 接入 P1，并覆盖 close/replace/quit intent、重复请求、拒绝回滚和契约 parity。T28 已接入资源到 Markdown 的选择/粘贴/拖放、受控读取、文档相对路径、缺失重定位和移动后链接重写；T29 已增加 Rust↔TS 菜单状态字段/动作值 parity 和聚焦窗口菜单策略测试；T30 增加所有导出 interface/字符串常量的 parity 登记总守卫、图片选择 tagged union 形状断言和统一 Rust 服务门禁。T31 已在 macOS/Windows 真实桌面 IPC 覆盖保存重开、WebView 文件输入到图片资源、外部修改和恢复；T33 新增 `WorkspaceMoveRisk` parity 与本地真实 IPC 风险检查。系统关闭/退出结算、原生选择器/剪贴板仍无人工平台证据。

### 8.3 页面与交互测试

- 计划：P1 覆盖 visual/source、格式化、空文档、只读、dirty/saving/saved/save_failed/conflict、恢复、另存、图片、状态栏、菜单和窗口门禁；P2 覆盖恢复入口与单项失败；验证 1280/1050/820/740 px 和低高度，不测试手机重排。
- 具体完成情况：T25 已将 visual/source 接入生产 P1，T26 已增加真实保存和窗口结算；T27 已用组件测试覆盖冲突/恢复/另存、P2 根入口、外部删除保护和安全关闭门禁。T28 已覆盖图片流程和 1280/820/740 px 弹层；T29 又验证 1280/1050/820/740 px 与 740×460 低高度工作台、文件树抽屉焦点、状态栏收敛和无根滚动。T31 已在 macOS/Windows runner 用独立临时工作区完成 P1/P2 真 IPC、1100/740 px、两模式编辑、图片、保存、外部修改和恢复回归；T33 复用既有移动弹层并用组件测试与本地真桌面验证风险文案、继续按钮和取消零副作用。该 WebView 自动化不替代原生图片输入、系统关闭/退出或系统辅助技术人工验收。

### 8.4 组件资产闭环测试

- 计划：验证 AppDialog/AsyncStatePanel/focusContainment 真实复用；新增 DocumentEditorShell、SaveStatus、ConflictDialog、RecoveryDialog、AssetDirectoryDialog 的 DESIGN 登记和 P1/P2 消费；扫描生产 CSS 只使用语义 token；配置字段从默认、保存、读取、消费到重置全链路可见。
- 具体完成情况：T25 已登记编辑壳相关组件；T27 新增并登记 `ConflictDialog`、`RecoveryDialog`、`SaveCopyDialog` 与 `ContentSafetySummary`；T28 新增并登记 `AssetDirectoryDialog`、`workspaceAssetPath` 与 `workspaceImageNodeView`；T29 新增并登记 `DocumentStatusBar`，同时把 `SaveStatus` 消费者更新为工具栏和状态栏。这些流程真实复用语义组件和既有 token，没有复制焦点、遮罩、保存状态或私有颜色；生产 CSS/TSX 扫描除 `tokens.css` 外无色值/渐变命中。

### 8.5 权限与数据范围测试

- 计划：覆盖前端任意绝对路径注入、根外资源目录、`..`、symlink、save-copy token 重放/换靶、恢复路径伪造、MIME/签名不一致、只读、权限撤销和 app data 不可写；确认 capability 无宽泛文件权限。
- 具体完成情况：T20 已覆盖 recovery workspace 身份绑定；T21 已覆盖另存单目标授权；T22 已覆盖资源目录绝对/`..`/非法名/symlink 拒绝、MIME/签名不一致、SVG/超限、错误 workspace、token 重放/过期/并发和取消前目标变化。Web 输入使用 raw bytes + opaque upload id，确认命令不接收绝对路径。T31 已在 macOS/Windows 真 Tauri IPC 验证 WebView 文件输入到资源落盘，但原生选择器、系统剪贴板和 Finder/Explorer 拖入仍无人工证据。

### 8.6 回归测试

- 计划：T30 先把 editor/roundtrip/recovery/assets 的单元、服务集成和 parity 纳入统一 `pnpm test` 或明确的 CI 必跑脚本；T31 再运行第一阶段全部文件树、CRUD、watch、安全写、窗口、一目录一窗口、P1/P2、焦点和桌面 E2E 跨模块回归。
- 具体完成情况：T30 已新增 `test:editor`、`test:roundtrip`、`test:rust`，并由 `pnpm test` 统一运行 Node、Vitest 和 Rust 非桌面门禁；T33 最新本机结果为 Node 30/30、Vitest 176/176、Rust 180 项通过且 1 项手动性能探针忽略。默认全量 `cargo test` 的既有并发 flaky 已以统一临时目录修复并连续 10/10 通过；T31 把第一阶段 P1/P2 基线与第二阶段编辑、资源、保存、外部修改、恢复串成 8 条真桌面用例，T33 增加第 9 条目录图片移动风险检查与取消回归。run `30062045288` 已在 macOS/Windows 完整重跑 T31 门禁并双绿；T33 尚未推送，不宣称新远端结果。

### 8.7 异常与边界测试

- 计划：覆盖 0 字节、100 KB、5 MB 和 64 MiB 临界文档；非法 UTF-8、UTF-8 BOM、LF/CRLF/CR/mixed；未知 Markdown/raw HTML/frontmatter；IME composition；保存中继续输入；外部删除/修改；二次外部变化；进程退出；快照损坏/过期/超限；磁盘满；图片多选部分失败；Windows 目标占用和路径前缀。
- 具体完成情况：T21 已覆盖 UTF-8 BOM、LF/CRLF/CR/mixed、非法 UTF-8、只读、二次外部变化、写入故障、取消和同名目标覆盖；T22 已覆盖图片格式伪造、20 MiB 超限、同名不覆盖、部分写入、取消换靶和 symlink。T23 已覆盖浏览器 composition 分组、创建中销毁、只读、100 KiB 正常挂载、5/20/64 MiB 字节降级、2000 个非空内容行门槛及紧凑列表/表格盲区；T25 又在生产 P1 接线回归密集列表 source-only、陈旧兼容性结果拒绝、adapter 初始化失败保留内容和刚输入即切换不丢内容；T26 覆盖保存期间继续编辑、恢复失败不自旋、晚到快照、文件切换、重复 close、根替换和多窗口退出取消。系统 IME 候选窗、峰值内存、强制进程终止、磁盘满及 Windows 原生运行仍待后续任务。

### 8.8 桌面 E2E 与跨平台

- 计划：由 T31 扩展现有隔离 E2E，至少覆盖 P1 打开 fixture→排版编辑→源码验证→保存→重开，外部修改→冲突，崩溃快照→恢复，图片导入→磁盘/链接；macOS/Windows runner 均执行 T30 非桌面门禁、平台适用测试、桌面 E2E 和生产构建。
- 具体完成情况：T31 已在本机 macOS 重新构建专用 E2E 应用并通过 8/8：前四条保留 P2/P1 IPC、布局与焦点基线，后四条覆盖两模式编辑/资源输入/保存重开、恢复仓储、外部修改内容安全和显式恢复。T33 新增第 9 条本地真 IPC 用例，在临时工作区创建图片，验证目录风险命令、可见确认文案、取消以及目录/文档仍可读取。套件使用独立临时工作区、确定性流程不重试；正式构建确认不含 E2E 标记。run `30060302937` 暴露 Windows Rust lint，run `30060937964` 又暴露 fixture CRLF 与测试固定 LF 假设；两次红灯均按真实日志修复且未削弱门禁。run `30062045288` 已在 macOS/Windows 完整通过 T31 的许可证、类型与前端、Rust lint/测试、8/8 桌面 E2E、未签名生产构建和 artifact 上传。T33 的 9/9 仅在本机 macOS 执行，Windows 与远端 CI 未执行；Windows 原生系统对话框、拖放、剪贴板、菜单和辅助技术继续保留人工未验证。

### 8.9 验证清单

- 图示与原型一致性：P1 只实现本阶段区域；未实现的页签、大纲、搜索、阅读、专注和主题保持隐藏/禁用；P2/P3 边界不扩张。
- 配置闭环：`assetDirectory` 和 recovery policy 有默认、保存、读取、消费、重置/清理、非法值和旧/未知版本处理。
- 需求映射：R1～R34 每项均有任务或跳过原因；T18～T33 在第 3、5、6 章编号一致。
- 页面功能点：7.1.1～7.1.7、7.2.1～7.2.3、7.3.1～7.3.3 均明确本阶段技术实现或跳过状态。
- 内容安全：任何失败都可说明当前内容位于内存、恢复快照或磁盘何处；没有虚假“已保存”。

### 8.10 建议执行命令

```bash
source /Users/pengshuaifeng/.nvm/nvm.sh
nvm use
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:editor
pnpm test:roundtrip
pnpm test:rust
pnpm test:licenses
pnpm licenses:check
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-features
pnpm test:e2e
pnpm tauri build --no-bundle
```

T18/T30/T31 若新增稳定脚本，必须同步 `package.json`、README、AGENTS 和 CI；不得只在个人 shell 使用未归档命令。

## 9. 发布与回滚

- 发布前检查：第二阶段仍只生成内部未签名测试构建；T31 代码与后续文档提交已取得远端 macOS/Windows 双绿，T32 文档/需求复核和本地阶段验收已完成，T33 目录图片移动风险提示已完成本地门禁和 9/9 真桌面回归但尚未取得新远端结果。正式签名、发布和原生系统人工验收仍不属于本结论。
- 发布步骤：T31 已经用户授权推送并取得 macOS/Windows CI 与 artifact；不做签名、公证、自动更新或公开发布。
- 配置或环境变量：无业务环境变量；E2E 继续使用编译期 feature 和临时 `PLAINROOT_E2E_DATA_DIR`，生产构建必须确认不存在 WebDriver/fixture/测试命令。
- 代码回滚：按任务提交回退依赖、editor adapter、Rust 命令和页面入口；回退后运行第一阶段全量基线。
- 配置回滚：退出应用后可备份/删除 recovery/preferences 回到无恢复/default assets；未知 schema 文件不得被旧代码覆盖。
- 用户数据回滚：成功写入的 `.md` 和资源文件不随版本回滚自动改写或删除；冲突覆盖和另存的结果只能通过明确反向操作、恢复快照或系统备份处理。
- 不可回滚边界：用户已确认的磁盘保存是业务提交点；应用只保证保存前冲突/确认和失败安全，不提供 R17 历史版本能力。

## 10. 风险、已确认决策、假设与待确认项

### 10.1 风险

- 冲突、恢复、资源目录和另存副本弹层没有 P1 HTML 原型证据。缓解：明确以 requirement 5.5/5.6/7.1.2、现有 AppDialog/AsyncStatePanel/focusContainment 和 DESIGN 弹层规范为事实源；T27/T29 在编码前审查信息层级、危险动作、键盘焦点和 1280/820/740 px，若出现会改变流程或验收的布局歧义则暂停并补原型/确认。
- Milkdown/Remark 序列化可能规范化空白、列表或表格写法，并可能无法原样承载未知扩展语法。缓解：T18 硬门禁、raw 节点/源码降级、语义往返语料；失败即停，不静默缩需求。
- 两个 editor 的事务模型不同，跨模式统一撤销可能出现历史分叉或高内存。缓解：app-level 可逆 patch、adapter 内部 history 不作事实源、内存上限和大文档压力测试。
- 当前 app-level patch、hash 与撤销校验对每次变更仍为 O(全文长度)，64 MiB 小编辑虽只保存 1 B patch，本机单次记录/撤销仍约 486/255 ms。T26 又在本机 debug 测试路径测得 5/20/64 MiB 完整 safe-write 约 430/1650/5558 ms，证明大源码文档保存仍有可见延迟。缓解：现已采用尺寸分级防抖、保存/快照分别单飞和 pending edit 追赶；T31 的桌面回归使用普通 fixture，没有取得 release/WebView 大文件或峰值内存证据。不得把功能 E2E、内存有界或写入次数受控误写成大文件性能通过。
- 恢复快照包含敏感正文。缓解：只在 app data、opaque 名称、Unix `0600`、短期限/有界容量、用户可删除，不上传、不记录日志正文。
- 自动保存与 watch 竞态可能把自身写入误判为外部冲突或漏掉真实外部变化。缓解：继续使用 operation id 一批次消费，同时以 revision/hash 为最终权威。
- 关闭/退出握手可能与 window coordinator 锁形成死锁。缓解：锁内只创建 intent/记录状态，绝不持锁等待前端；重复/失效 intent 有明确幂等测试。
- 工作区外另存扩大单次写入面。缓解：原生选择器、一次性目标 token、再次校验父目录/链接/目标状态，不持久化目录权限。
- 图片输入可能伪造 MIME、体积过大或留下孤儿副本。已实现 Rust 文件签名/20 MiB 大小校验、唯一 no-replace 命名和 import token 确认/取消；正常失败/取消/过期/进程释放只按身份与 hash 清理本次新建副本。强制终止发生在写盘与插入之间时仍可能遗留孤立资源，应用不会在缺少持久证据时猜测删除。
- 目录级风险检查不能证明图片是否被 Markdown 引用，也不能在超大目录中无限扫描。T33 只把已配置资源目录、受支持图片扩展名和检查不完整作为“可能断链”的保守证据，并把递归访问限制在 10,000 个目录项；符号链接不跟随，读取偏好或扫描失败时提示风险但不声称发现具体图片/引用。该策略可能多提示一次，但不会静默移动或用猜测批量改写其他文档。
- Milkdown/CodeMirror 增加包体和首开耗时。T25 已按模式将两种 editor 懒加载；T31 最新生产构建为入口 442.90 kB、排版 chunk 337.06 kB、源码 chunk 544.41 kB，源码独立 chunk 仍触发 500 kB 告警。T31 已证明真实 WebKit 可以完成两种模式切换，但没有形成可比较的首开耗时门槛；后续如出现可见延迟再拆分 CodeMirror language/search，加载态仍不得显示旧内容。
- 安全写与恢复快照都需要写入完整 Markdown；若对 5～64 MiB 文档固定使用 800 ms 自动保存和 2 秒快照，会产生明显磁盘写放大、hash/序列化开销和输入抖动。缓解：T26 已按 5/20 MiB 阈值延长防抖，大文件快照连续输入期最多每 10 秒一次，保存/快照分别单飞并合并陈旧请求；后续只能依据 release/WebView 与双平台证据再校准，不能为性能绕过关闭结算或 revision 校验。
- 中文/日文 IME、macOS/Windows 剪贴板和拖放事件存在 WebView 差异。T23 已验证浏览器 composition 分组与 Chromium 中文 contenteditable 输入，但没有系统输入法候选窗证据；缓解仍为组件自动化 + macOS 实机 + Windows CI，Windows 原生人工项诚实保留。
- Milkdown 性能不仅取决于字节数，也取决于节点密度。T23 初版空行块数代理经复核发现会漏掉紧凑列表/表格，现已收敛为 `2 MiB + 2000 个非空内容行` 双门槛并在挂载前降级；T25 已让生产 AST 兼容性解析与 P1 共同消费该门槛，并以密集列表回归确认不会残留陈旧排版实例。T26 继续记录 session patch/hash 和保存开销；T31 未取得 Windows 或峰值内存证据，当前不得提高门槛。

### 10.2 已确认决策

- 用户于 2026-07-22 确认采用 Milkdown 7.21.3 + CodeMirror 6 的门禁方案；PoC 不通过时停止并重新确认，而非静默更换。
- 统一 Markdown 内容源采用语义无损口径；不支持语法保留原始源码并允许源码模式编辑，不要求所有未编辑文本字节级完全一致。
- 恢复仓储独立于现有 state v1，每文档一份最新快照，默认 7 天、32 项、128 MiB、最旧优先。
- 另存副本允许工作区外单文件写入，但仅消费用户本次原生选择的单目标令牌，不扩大根授权。
- 图片资源目录按工作区配置，默认 `assets/`，P1 提供最小对话框和恢复默认，始终限制在授权根内。
- 用户于 2026-07-24 确认目录图片移动策略：移动已配置资源目录或递归包含 PNG/JPEG/GIF/WebP 的目录前显示非阻塞警告；文案只说明未打开 Markdown 的相对图片链接可能失效，继续按钮明确风险，取消不移动；不建立或虚构引用命中，不自动批量改写其他文档。
- 第二阶段保持每窗口单文档，不实现页签；窗口门禁只处理当前 session，阶段 3 扩展为全部页签。

### 10.3 非阻塞假设

- 自动保存 800 ms/2 秒/5 秒尺寸分级和大文件快照 10 秒限频已由 T26 接入并用 fake timer 锁定；它们是基于当前全量写入成本的保守运行常量，不等于性能最终定稿。T23 的排版门槛仍为 `≤2 MiB 且 ≤2000 个非空内容行`，更大的文档进入源码模式；T31 只取得普通 fixture 的 WebKit 功能证据，没有 release/WebView 大文件或双平台性能证据，不调整这些常量。
- 首版图片导入支持 PNG/JPEG/GIF/WebP，SVG 因主动内容风险明确拒绝；若要支持 SVG，需先补安全渲染规则和验收后另行确认。
- 单次图片大小上限已在 T22 固化为 20 MiB；Web 输入使用 raw IPC 避免 JSON 数字数组放大，超限和格式错误返回稳定错误且不产生 Markdown 断链。
- 文档内查找使用 CodeMirror 能力；T25 已让排版模式的“查找”先安全切换到源码并打开当前文档查找，不注册工作区索引、菜单或结果页，仍不构成 R12 工作区搜索。
- Windows 无用户侧实机，使用 GitHub Actions 取得编译/测试/WebView2 E2E；原生 UI 人工证据继续登记到阶段 8。

### 10.4 待确认项

- 无阻塞计划启动的问题。
- 非阻塞：正式发布前需决定 recovery 数据的用户设置入口和隐私说明位置；第二阶段已提供恢复弹层内的删除入口，不提前建设完整设置页。
