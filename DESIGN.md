---
version: alpha
name: Plainroot
description: 面向 Windows 与 macOS 的本地优先 Markdown 桌面编辑器，采用安静、克制、适合长时间写作与阅读的中性工作台视觉。
colors:
  stage: "#d7d7d8"
  chrome: "#ececed"
  chrome-strong: "#e4e4e6"
  paper: "#f3f3f2"
  paper-deep: "#eeeeed"
  paper-hover: "#f8f8f7"
  heading: "#222226"
  text: "#28282c"
  muted: "#66666d"
  quiet: "#85858c"
  line: "#ceced2"
  line-strong: "#b9b9bf"
  accent: "#70677f"
  accent-soft: "#dedbe3"
  on-accent: "#ffffff"
  success: "#52735e"
  warning: "#8a6d3f"
  danger: "#9b5050"
typography:
  ui-sm:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: 12px
    fontWeight: 400
    lineHeight: 18px
  ui-md:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: 13px
    fontWeight: 400
    lineHeight: 20px
  document-body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.76
  document-h1:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: 35px
    fontWeight: 720
    lineHeight: 1.22
  code:
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace'
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.65
rounded:
  sm: 4px
  md: 6px
  lg: 9px
  window: 11px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
effects:
  overlay: "rgb(34 34 38 / 18%)"
  dialog-backdrop: "rgb(34 34 38 / 24%)"
  drawer-shadow: "18px 0 44px rgb(34 34 38 / 16%)"
  dialog-shadow: "0 18px 48px rgb(34 34 38 / 18%)"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.md}"
  input-default:
    backgroundColor: "{colors.paper}"
    borderColor: "{colors.line}"
    focusColor: "{colors.accent}"
    rounded: "{rounded.sm}"
  dialog-default:
    backgroundColor: "{colors.paper}"
    borderColor: "{colors.line-strong}"
    rounded: "{rounded.lg}"
  document-canvas:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.text}"
    maxWidth: 800px
---

# Plainroot Design System

> 本文是 Plainroot 前端视觉、布局和交互的长期入口。正式工程已经建立，alpha token 仍来自三份已确认原型的共同实现；T12/T13 已将完整浅色语义 token、P2 启动页、P1 第一阶段工作台壳、共享对话框与异步状态面板落入运行时代码，后续页面应继续收敛同一事实源，自动化测试覆盖到的区域以代码为数值事实。

当前证据：

- 工作台：`agent-works/markdown-editor-desktop/prototypes/markdown-workbench.html`
- 启动页：`agent-works/markdown-editor-desktop/prototypes/workspace-launcher.html`
- 主题工作室：`agent-works/markdown-editor-desktop/prototypes/theme-preset-studio.html`
- 产品状态、范围与交互：`agent-works/markdown-editor-desktop/requirement.md`
- 页面开发流程：`agent-works/markdown-editor-desktop/page-development-workflow.md`

## 1. Visual Theme & Atmosphere

Plainroot 是本地写作与阅读工具，不是通用后台、营销页面或知识图谱产品。界面应安静、稳定、克制，让窗口 chrome 退居背景，让文档、路径和保存状态成为主角。

Key Characteristics：

- 使用暖度极低的中性灰纸面，不使用纯白大面积背景，也不使用纯黑正文。
- 紫灰 `accent` 只承担选中、焦点、主操作和少量结构提示，不做大面积装饰渐变。
- 通过纸面、chrome、边框和轻阴影表达层级；避免卡片套卡片和悬浮面板堆叠。
- 桌面控件紧凑，正文排版舒展。应用壳和阅读区不能共用同一字号密度。
- 真实文件状态优先于装饰：保存、只读、冲突、失效和错误必须有文字或结构表达，不能只靠颜色。
- 平台窗口控制尊重 Windows/macOS 原生惯例，不把 macOS 红黄绿按钮机械复制到 Windows。

## 2. Color Palette & Roles

| 角色 | Token | 用法 |
|---|---|---|
| 原型舞台 | `stage` | 仅用于独立原型外部背景；正式原生窗口内不应出现 |
| 应用 chrome | `chrome` / `chrome-strong` | 侧栏、工具栏、状态栏与标题栏；`strong` 用于更稳定的边界层 |
| 文档纸面 | `paper` / `paper-deep` / `paper-hover` | 编辑器、输入面和普通对话框；`deep` 用于代码块、说明块和轻量选中；`hover` 只用于纸面控件悬停 |
| 主文字 | `heading` / `text` | 标题与正文，确保长期阅读清晰 |
| 弱文字 | `muted` / `quiet` | 路径、时间、快捷键和辅助说明；关键错误或操作不可只用 `quiet` |
| 边界 | `line` / `line-strong` | 常规分隔与强调边界，不用阴影替代所有分隔 |
| 交互强调 | `accent` / `accent-soft` | 主按钮、活动页签、焦点、当前大纲与轻选中 |
| 状态 | `success` / `warning` / `danger` | 成功、警告、失败或破坏性动作；必须搭配文字、图标或结构语义 |
| 遮罩与层级 | `overlay` / `drawer-shadow` / `dialog-backdrop` / `dialog-shadow` | `overlay` 与 `drawer-shadow` 用于窄窗抽屉，后两者用于模态任务；页面不得复制私有 rgba/rgb 值 |

规则：

- 页面和组件只消费语义 token，不在局部复制相同 hex。
- 主按钮可用 `accent` 实底；次按钮使用 `paper + line-strong`；危险按钮默认保持浅背景与危险文字，只有明确不可逆且需要强提醒时才考虑实底。
- Hover 优先由当前表面与 `text`/`accent` 混合得到，不另建随机灰色。
- 生产危险色统一消费 `danger`（当前值 `#9b5050`）；启动页原型保留的 `#955252` 仅是原型历史证据，不得进入正式页面样式。
- 自定义主题保存至少要满足普通文字 `4.5:1`、大字号文字 `3:1` 的对比目标；明暗两套是否必须联合通过见 Known Gaps。
- 颜色预设不得改变 Markdown 文件内容，也不得把状态色当作正文任意着色工具。

## 3. Typography Rules

字体族：

- UI 与正文使用系统无衬线栈，保证 Windows/macOS 离线可用；不依赖联网字体。
- Markdown 源码、路径、色值和代码使用系统等宽栈。

层级：

| 场景 | 建议层级 | 规则 |
|---|---|---|
| 工具栏、树、页签、状态栏 | `ui-sm` | 主要在 `10.5–12.5px` 原型区间内校准，保持可读，不用小字制造“专业感” |
| 对话框正文与普通表单 | `ui-md` | 使用清楚的行高，说明文字可降一级但不得发灰到不可读 |
| 长文正文 | `document-body` | alpha 基线 `17px / 1.76`，窄窗口可轻微收敛但不能与 UI 字号混用 |
| 文档 H1/H2/H3 | 35/23/18px 基线 | 主要靠字号、字重、留白和分隔线分层，不靠彩色标题 |
| Markdown 源码与代码块 | `code` | 保留滚动与原始文本，不因美化静默改写 |

排版原则：

- 正文宽度以约 `760–820px` 为 alpha 校准范围，宽屏不无限拉长；当前画布 token 上限为 `800px`。
- 段落、列表、引用、代码块和标题使用稳定垂直节奏，优先消费 spacing token。
- 文件名和路径默认单行省略并提供完整值；正文长文本按 Markdown 语义正常换行。
- 数值、快捷键和路径不使用装饰性字重；粗体只表达结构或业务强调。

## 4. Component Stylings

### 应用窗口与 chrome

- 窗口由标题栏、可选页签层、文档工具层、主工作区和状态栏组成；稳定 chrome 不随正文滚动。
- 原型外框 `11px` 圆角和大阴影只用于非原生演示窗口；正式 Tauri 窗口是否保留外框取决于平台装饰方式。
- 标题栏、菜单和窗口控制必须具有平台适配，不用网页按钮伪造系统能力。

### 按钮、图标与输入

- 同一操作组最多一个主按钮。次要、取消和危险操作保持明确层级。
- 纯图标按钮使用约 `29–30px` 点击面、`16px` 图标、透明默认背景；必须提供可访问名称和 tooltip。
- 输入框使用 `paper` 表面、`line` 边框；聚焦时使用 `accent` 边框和轻量 focus ring，不能只移除 outline。
- Disabled 除降低透明度外还要保留不可用语义；Loading 防止重复提交但不隐藏当前目标和安全状态。

### 页签、文件树与大纲

- 活动页签用纸面、主文字和底部 `accent` 线表示；未保存状态使用点标记并配合可访问文本。
- 页签文件名、路径、树节点和大纲长文本单行省略；完整内容通过 tooltip、状态栏或详情承接。
- 文件树与大纲各自只在明确侧区内滚动，中央正文拥有主滚动；避免窗口、页面、正文三层同时滚动。
- 文件树的选中、磁盘处理中、只读、失效和错误状态必须区分，不能把 hover 当作选中。

### 对话框、状态与反馈

- 普通确认和少字段输入使用居中 dialog；目录决策、冲突和关闭保护必须写明对象、后果与安全边界。
- 破坏性按钮使用具体动词，如“放弃并关闭”“移除记录”，不使用含糊“确定”。
- 对话框支持 Esc、焦点圈定和关闭后焦点恢复；存在未保存草稿或破坏性结果时，Esc 行为必须与取消契约一致。
- Toast 只报告已完成的轻量结果，不承载需要选择、重试或长期查看的错误。
- 页面至少覆盖 ready、loading、empty、error；惰性恢复或尚未读取的文件使用 unloaded，不能误报为空文件；文件场景再按需覆盖 readonly、dirty、saving、conflict、missing 和 permission-denied，状态之间必须有明确优先级。
- 同一区域并存多个状态时，公共状态契约按 `permission-denied > missing > conflict > error > unsupported > saving > loading > dirty > readonly > empty > unloaded > ready` 选择主状态。权限、位置、冲突和错误使用 assertive alert，其余进度与稳定状态使用 polite status；颜色之外必须显示明确文字标签。

### 文档画布与主题工作室

- 编辑画布以 `paper` 为连续纸面，不把每个 Markdown 块做成卡片。
- 源码模式保留等宽文本、原始字符和滚动位置；排版模式与源码模式共享内容状态。
- 主题工作室保持“预设库 → token 编辑 → 实时预览 → 固定提交区”的关系。内置预设只读，草稿与已保存值视觉上可辨。
- 颜色错误紧邻字段显示具体 token、调色板和比值，不能只显示全局红色提示。

## 5. Layout Principles

页面原型：

| 页面 | 原型类型 | 主任务 | 核心结构 |
|---|---|---|---|
| Markdown 工作台 P1 | workbench | 编辑与阅读当前文档 | 窗口 chrome + 页签 + 工具栏 + 文件树/文档/大纲 + 状态栏 |
| 工作区启动 P2 | launcher | 打开本地目录或文件 | 欢迎与主入口 + 最近工作区列表 |
| 颜色主题工作室 P3 | settings studio | 编辑、验证、预览并保存主题 | 设置导航 + 预设库 + token 编辑 + 实时预览 + 固定提交区 |

已登记运行时复用单元：

登记范围包括跨页面复用单元、页面壳，以及承担独立安全或状态职责且具有稳定边界的关键页面组件；只承载一次性排版的页面私有包装不单独登记。

| 复用单元 | 代码事实源 | 当前消费者 | 稳定职责 |
|---|---|---|---|
| `focusContainment` | `src/components/focusContainment.ts` | `AppDialog`、P1 窄窗文件树抽屉 | 可聚焦元素筛选、进入焦点、Tab/Shift+Tab 圈定和安全焦点恢复；不持有页面业务状态 |
| `AppDialog` | `src/components/AppDialog.tsx` | P1/P2 打开流程、文件操作、永久删除、恢复/冲突/另存 | 原生 dialog、共享焦点圈定、Esc/遮罩关闭、关闭门禁、焦点返回和统一动作区 |
| `AsyncStatePanel` | `src/components/AsyncStatePanel.tsx`、`src/components/asyncState.ts` | 根启动状态、P1/P2 加载、错误、阻塞与恢复；页签状态模型复用纯状态契约 | 类型化状态与公共优先级、可见非颜色标签、自动 tone/role/aria-live、说明和恢复动作；非视觉消费者不得复制第二套优先级 |
| `WorkspaceLauncher` | `src/features/launcher/WorkspaceLauncher.tsx` | P2 | 本地打开主入口、最近记录、授权、窗口决策、打开方式设置、根会话恢复和恢复快照的非阻塞入口；恢复正文由 P1 消费 |
| `WorkspaceWorkbench` | `src/features/workbench/WorkspaceWorkbench.tsx` | P1 | 当前根工作区壳、真实文件操作、活动文档编辑投影、自动/手动保存、恢复载入、冲突/另存、外部删除保护、全页签窗口结算与窄窗目录抽屉 |
| `WorkspaceOpenDecisionDialog` | `src/features/workspace-open/WorkspaceOpenDecisionDialog.tsx` | P1、P2 | 复用 `AppDialog` 统一当前窗口/新窗口/取消决策和“记住这次选择”；明确当前窗口替换仍先处理全部页签，偏好或窗口提交失败时保持弹层并展示真实错误 |
| `WorkspaceOpenPreferenceDialog` | `src/features/workspace-open/WorkspaceOpenPreferenceDialog.tsx` | P1、P2、原生设置菜单 | 复用 `AppDialog` 承载 `ask/current_window/new_window` 三值偏好读取、保存和恢复为每次询问；只决定打开位置，不绕过授权、同目录聚焦或内容安全结算 |
| `WorkspaceTabManager` | `src/features/tabs/WorkspaceTabManager.ts` | P1 文件树、可见页签切换、最近关闭与批量结算 | 非视觉多文档 runtime：按 Rust opaque 路径身份唯一打开/聚焦和重新校验最近关闭项，每页签独立持有 session/history/save controller，切换/关闭前提交活动 adapter 投影且任意时刻只允许一个真实 editor adapter；提供全目标结算、单 revision 批量关闭和多 runtime 路径原子重映射，不承担页签视觉、启动持久恢复或用户决策 UI |
| `WorkspaceTabBar` | `src/features/tabs/WorkspaceTabBar.tsx` | P1 | 消费 manager 快照投影真实 tablist、活动项、同名路径提示和非颜色状态；提供 roving tabindex、鼠标/键盘激活、单项/其他/右侧/全部关闭入口、当前窗口排序与最近关闭入口，页签 viewport 独立横向滚动；具体内容安全决策委托统一结算弹层 |
| `TabMenu` | `src/features/tabs/TabMenu.tsx` | `TabOverflowMenu`、`TabContextMenu` | 共享 menu/分区语义、可聚焦项筛选、方向键/首尾遍历、Esc/Tab/外部点击关闭和焦点返回；溢出定位、最近关闭与页签动作由薄消费者分别配置，不在菜单内复制页签状态 |
| `TabSettlementDialog` | `src/features/tabs/TabSettlementDialog.tsx`、`src/features/tabs/tabSettlement.ts` | P1 单页签/批量关闭与文件树破坏性操作 | 复用 `AppDialog` 承载不可变目标清单、逐项非颜色内容安全状态、重试保存/冲突/另存/放弃和最终一次性提交门禁；显式证据绑定页签 incarnation/generation/editVersion，继续编辑后必须重新决策，不创建第二套保存或冲突通道 |
| `WorkspaceTabSessionPersistence` | `src/features/tabs/tabSessionPersistence.ts` | P1 | 将当前轻量页签投影以防抖、revision/CAS 写入既有 Rust 会话仓储；不保存正文/history，不覆盖尚未由启动恢复消费的既有非空会话 |
| `tabPathImpact` | `src/features/tabs/tabPathImpact.ts` | P1 文件/目录重命名、移动与删除预检 | 纯函数收集受影响打开页签、目标路径和已加载文档图片链接改写预案；不执行磁盘写入或 runtime 提交 |
| `WorkspaceTree` | `src/features/workbench/WorkspaceTree.tsx` | P1 | 渐进目录节点、磁盘提交后更新、只读标识、异步刷新期间也稳定的单一 Tab 停靠点，以及上下/首尾/父子方向键导航 |
| `PermanentDeleteDialog` | `src/features/workbench/PermanentDeleteDialog.tsx` | P1 永久删除流程 | 复用 `AppDialog` 承载删除提案、显式不可逆确认、提交门禁、阶段化错误反馈与安全取消 |
| `workspacePath` | `src/features/workbench/workspacePath.ts` | `workspaceTreeState`、`WorkspaceWorkbench` | 工作区相对路径的父级计算、同路径/子路径边界判断和前缀重映射；根目录键仍由树状态层适配 |
| `DocumentEditorShell` | `src/features/editor/DocumentEditorShell.tsx` | P1 | 同一 `DocumentSession` 的排版/源码投影、模式切换前内容/选择/锚点提交、兼容性重评估、延迟加载、图片导入编排和统一命令转发；不持有磁盘保存或第二份正文 |
| `EditorToolbar` | `src/features/editor/EditorToolbar.tsx` | `DocumentEditorShell` | 排版/源码模式、统一撤销重做与排版格式位于可横向滚动区；保存、另存、当前文档查找固定在主操作区，图片选择与低频资源目录设置收敛为同一资源组；不重复承载持续保存状态 |
| `AssetDirectoryDialog` | `src/features/editor/assets/AssetDirectoryDialog.tsx` | `DocumentEditorShell` | 复用 `AppDialog`/`AsyncStatePanel` 承载当前工作区资源目录读取、校验、保存与恢复默认；提交失败保留原偏好和输入，processing 期间禁止关闭 |
| `workspaceAssetPath` | `src/features/editor/assets/workspaceAssetPath.ts` | `DocumentEditorShell`、P1 移动流程 | 工作区资源路径与当前文档相对 Markdown 链接之间的根内转换，并按 AST 位置重写移动后受影响的图片 URL；不解析或改写普通链接 |
| `SaveStatus` | `src/features/editor/SaveStatus.tsx` | `DocumentStatusBar` | 将 `DocumentSaveState` 映射为文字、结构和语义色共同表达的单一持续状态；不自行宣称磁盘提交成功 |
| `DocumentStatusBar` | `src/features/editor/DocumentStatusBar.tsx` | P1 | 持续投影当前 session 的保存、模式、字/字符数、编码、换行、源码行列或排版选区语义、工作区可写性与当前文档相对路径；完整路径通过 tooltip 承接，只有活动反馈进入 live-region，窄窗先隐藏次要统计 |
| `ContentSafetySummary` | `src/features/editor/recovery/ContentSafetySummary.tsx` | `ConflictDialog`、`SaveCopyDialog` | 统一呈现当前正文位于内存、恢复快照或磁盘的安全状态与保存状态；不自行改变 session |
| `ConflictDialog` | `src/features/editor/recovery/ConflictDialog.tsx` | P1 外部冲突流程 | 展示路径、磁盘证据和内容安全，承载重新加载、保留、另存与二次覆盖确认；令牌过期或磁盘再变化时回到可重试状态 |
| `RecoveryDialog` | `src/features/editor/recovery/RecoveryDialog.tsx` | P1、P2 恢复入口 | 按条目展示恢复元数据、隔离读取/删除失败并提供恢复或打开工作区动作；恢复正文不直接写入磁盘 |
| `SaveCopyDialog` | `src/features/editor/recovery/SaveCopyDialog.tsx` | P1 只读、冲突、外部删除和主动另存 | 只消费原生选择器签发的单目标令牌，展示目标状态并对已有目标显式确认；不接收前端绝对路径 |
| `remarkMarkdownParser` | `src/features/editor/remarkMarkdownParser.ts` | P1 文档载入、`DocumentEditorShell` 模式切换 | 使用 Remark/GFM AST 识别 source-only 语法并共同消费排版字节/非空内容行门槛；解析结果受 generation/editVersion 约束 |
| `VisualMarkdownEditor` | `src/features/editor/adapters/milkdown/VisualMarkdownEditor.tsx` | `DocumentEditorShell` | 连续纸面上的 Milkdown 排版编辑、有效选区上下文工具栏、语义焦点/只读状态、受控链接与图片请求、缺失图片占位/重新定位和三态复制反馈；不持有文件保存或跨模式历史 |
| `MilkdownVisualAdapter` | `src/features/editor/adapters/milkdown/MilkdownVisualAdapter.ts` | `VisualMarkdownEditor` | CommonMark/GFM 与统一 `EditorAdapter` 事务桥接、选择/锚点、结构命令、受控图片 node view、session history 回调、异步生命周期和字节/非空内容行复杂度降级；不建立第二份 Markdown 或权威历史 |
| `workspaceImageNodeView` | `src/features/editor/adapters/milkdown/workspaceImageNodeView.ts` | `MilkdownVisualAdapter` | 将 Markdown 图片节点投影为受控 Blob 图片或带原路径的缺失占位；重新定位成功后只更新该节点 URL，节点更新/销毁时撤销 Blob URL |
| `SourceMarkdownEditor` | `src/features/editor/adapters/codemirror/SourceMarkdownEditor.tsx` | `DocumentEditorShell` | 连续源码画布、行号、中文当前文档查找/替换、键盘焦点、只读与共享 editor surface 命令；不注册工作区搜索或独立保存通道 |
| `CodeMirrorSourceAdapter` | `src/features/editor/adapters/codemirror/CodeMirrorSourceAdapter.ts` | `SourceMarkdownEditor` | Markdown 高亮、括号匹配、选择/滚动、统一 session history 回调、generation/editVersion 事务和原始换行投影；CodeMirror 内部 LF 视图不得反向归一 CRLF/CR/mixed raw Markdown |

布局规则：

- 主内容区必须获得剩余空间；使用 `minmax(0, 1fr)`、`min-width: 0` 和 `min-height: 0` 处理真实溢出，不靠随意硬编码视口高度。
- 工作台中央文档优先保留宽度。alpha 侧栏基线为左 `252px`、右 `220px`，正式实现需支持拖动、边界夹取、键盘调整和工作区记忆。
- 标题栏、页签、工具栏和状态栏保持稳定；文件树、大纲、编辑画布各自管理明确滚动，不让整页滚动吞掉窗口 chrome。
- 启动页只有“打开本地内容”一个主任务；最近列表是辅助入口，不加入营销导航、统计卡或空洞欢迎区。
- 主题工作室预览是验证编辑结果的必要区域，不得缩成无反馈的色块；低宽度先减少设置导航和次要预览 chrome。
- 弹窗覆盖当前任务但不改变背后工作区状态；复杂长流程若未来出现，优先独立设置页或明确分区，不塞进小对话框。

## 6. Depth & Elevation

- 常规层级优先用背景明度和 `line` 边界；卡片与列表行默认不加阴影。
- 原型窗口可使用双层轻阴影表达演示舞台；正式原生窗口使用系统阴影，不叠加网页大阴影。
- Dialog 使用 `line-strong`、`rounded.lg` 和单一高层阴影；Popover 比 dialog 更轻，Toast 使用深色实底。
- 窄窗侧栏抽屉使用 `overlay` 遮罩与 `drawer-shadow` 侧向阴影，不复用模态对话框的遮罩强度或居中阴影。
- 圆角遵循 `4 / 6 / 9 / 11px` 层级：微控件、普通控件、浮层、原型窗口。不得在页面内随机新增相近圆角。
- 遮罩保持中性半透明，确保上下文仍可识别；z-index 建立少量语义层级，不使用不断增大的局部数字竞争。

## 7. Do's and Don'ts

Do：

- 让文档、文件名、路径和真实状态主导界面层级。
- 优先复用同类组件和状态模型；第二处相同行为形成复用单元。
- 使用语义 token、稳定间距和平台原生能力。
- 为 loading、empty、error、只读、冲突和权限撤销提供真实承接。
- 用清晰动词描述保存、覆盖、另存、移除和放弃的结果。

Don't：

- 不做大 hero、渐变光晕、玻璃拟态、统计卡片墙或通用后台侧栏。
- 不把 Markdown 区块卡片化，不用纯白/纯黑制造强对比疲劳。
- 不新增无真实实现的可点击控件，不用固定数据或 toast 伪装系统能力。
- 不让页面、侧栏、弹窗和编辑器同时形成无边界的多层滚动。
- 不把长路径、文件名或页签强制换行撑高 chrome。
- 不用颜色作为保存、冲突、选中或危险状态的唯一表达。
- 不把主题颜色写进 Markdown，不把排版设置混入颜色预设身份。

## 8. Responsive Behavior

Plainroot 首发是桌面应用，响应式目标是窄桌面窗口可用，不是手机端重排。

- `≥1180px`：工作台三栏完整；主题工作室保留设置导航、预设库、编辑和预览。
- `940–1179px`：主题工作室先隐藏低频设置导航；工作台仍优先保证中央编辑器。
- `821–1050px`：工作台右侧大纲退化为按需抽屉，右侧理想宽度仍保存在工作区偏好中。
- `≤820px`：工作台左侧文件树也退化为抽屉，页签允许横向滚动，中央文档保留最小安全留白；关闭抽屉必须同时退出点击与键盘可达范围，打开后焦点进入抽屉，Tab/Shift+Tab 圈定，Esc 关闭并返回触发器。
- 启动页约 `760px` 以下由双栏变单栏；打开入口仍在最近列表之前，窗口 chrome 不丢失。
- 主题工作室当前原型最小宽度为 `760px`，不承诺手机布局；更窄窗口应阻止继续压缩或采用后续确认的分步编辑方案。
- 窄窗口退化不能覆盖已保存的理想侧栏宽度；恢复到宽窗口时回到用户设置。
- 所有模式支持键盘操作、可见焦点和 `prefers-reduced-motion`；隐藏区域必须有可发现的恢复入口。

## 9. Agent Prompt Guide

Quick Color Reference：

- 应用 chrome：`{colors.chrome}` / `{colors.chrome-strong}`
- 文档纸面：`{colors.paper}` / `{colors.paper-deep}`
- 正文：`{colors.heading}` / `{colors.text}` / `{colors.muted}`
- 交互：`{colors.accent}` / `{colors.accent-soft}`
- 边界：`{colors.line}` / `{colors.line-strong}`

Example Component Prompts：

- “按 Plainroot launcher 原型实现最近工作区空态：保留打开本地内容主入口，使用 paper/chrome 层级，不新增统计卡，并覆盖路径失效与重新授权。”
- “按 Plainroot workbench 规则实现文件树：侧区内滚、长路径省略、磁盘成功后更新、选中与处理中状态分离，并在 820px 以下退化为抽屉。”
- “实现 Plainroot 冲突对话框：显示目标路径、内容是否安全和明确结果动词，支持键盘焦点圈定与取消后焦点恢复。”

Iteration Guide：

1. 先核对页面职责、需求编号、当前阶段和原型，不先画通用页面。
2. 复用已存在的窗口壳、按钮、对话框、状态面板和 token；没有代码事实时按本文角色命名，脚手架建立后再登记真实组件。
3. 先完成真实 ready/loading/empty/error 与本地文件异常，再微调装饰。
4. 在宽窗口、1050px、820px 和页面专属临界宽度验证滚动、焦点、文本溢出和主任务可见性。
5. 视觉或交互决策改变时，同步本文与页面开发流程，不只修单页 CSS。

## 10. Known Gaps

- P2、P1 工作台壳与共享 `AppDialog`、`AsyncStatePanel` 已落地并消费 `src/styles/tokens.css`；T17 已完成页面私有颜色/渐变收口，并让 `AppDialog` 与 P1 窄窗抽屉共同消费 `focusContainment`。P1 文件树 reducer 与工作台页面共同消费 `workspacePath`，避免重命名/移动后的树状态与页面选择状态使用两套路径规则。P1 已真实消费 `DocumentEditorShell`、Milkdown/CodeMirror adapter、生产 Remark/GFM 兼容性解析器、统一格式栏、`SaveStatus` 和持续 `DocumentStatusBar`；两种 editor chunk 按模式延迟加载，加载回退复用 `AsyncStatePanel`。自动/手动保存和窗口结算已接入真实 session/磁盘结果；P1/P2 已接入受控恢复入口，P1 已提供冲突二次确认、另存副本和外部删除保护，全部消费真实 session、快照与一次性令牌。T28 已接入资源目录、系统选择器/粘贴/拖放图片输入、文档相对链接、缺失占位/重新定位与移动链接调整；T29 已让原生菜单和状态栏由当前聚焦窗口的同一 session 驱动，T34 又把保存状态收敛为状态栏单一位置、恢复当前文档路径，并让工具栏只滚动模式/格式区而固定保存与查找主操作。T37 已让 P1 消费 `WorkspaceTabManager`，保留每文档独立 session/history/mode 且只挂载活动 editor；T38 已接入真实 `WorkspaceTabBar` 与共享 `TabMenu`，提供可见页签、非颜色状态、当前窗口排序、单项关闭、溢出定位和键盘/焦点契约；T39 已让溢出菜单消费最近关闭、把当前顺序/活动项/最近项写入 Rust 会话仓储，并在文件树破坏性操作前生成全部打开页签与图片链接影响预案；T40 已新增 `TabSettlementDialog`，让单项/其他/右侧/全部关闭及命中打开页签的文件操作复用同一两阶段结算，并在磁盘成功后批量提交 runtime 路径或页签移除；T41 又让窗口替换、关闭和应用退出消费同一全页签结算，并让 P1/P2 共用打开位置决策与三值偏好弹层。已有非空会话的启动恢复和原生页签命令仍未实现。`PathStatus`、`DesktopWindowStatus` 未形成两个同职责消费者，因此未登记为空组件。P1 的大纲、可调布局与阅读区域，以及 P3 仍未实现，暗色令牌和完整主题能力也未建立，当前仍不能表述为完整代码级设计系统。
- 暗色主题尚无完整原型和 token；不得简单反转当前亮色值。R7/R15 阶段需补全明暗语义、派生状态和跨窗口预览测试。
- `17px / 1.76`、约 `760–820px` 正文宽度及 `252/220px` 侧栏是 alpha 校准基线，仍需在不同 DPI、中英文长文和 Windows 字体渲染下验证。
- 自定义主题“明暗两套调色板必须同时通过才允许保存”仍是待主题阶段确认的非阻塞决策；确认前不要写成用户已最终决定。
- HTML 原型主要表现 macOS 窗口外观；T17 提交已取得 Windows CI 证据，但 Windows 原生标题栏、菜单、快捷键、回收站和窗口行为仍需人工验收补证。
